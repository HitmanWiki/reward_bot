require('dotenv').config();
const { Telegraf } = require('telegraf');
const { ethers } = require('ethers');

// Configuration
const config = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    CHAT_ID: process.env.CHAT_ID,
    RPC_URL: process.env.RPC_URL,
    CONTRACT_ADDRESS: "0x88807fDabF60fdDd7bd8fB4987dC5A63cbd31f6a",
    USDC_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    UPDATE_INTERVAL: 900000, // 15 minutes
    REWARD_CHECK_INTERVAL: 60000, // 1 minute
    REWARD_GIF: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExcWJvYzV5b2VxY2VzZ2F4a2F5Y2x0bGJ6aHd3eG1rY3R5Z2R2dSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3o7abAHdYvZdBNnGZq/giphy.gif",
    STATS_GIF: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExcWJvYzV5b2VxY2VzZ2F4a2F5Y2x0bGJ6aHd3eG1rY3R5Z2R2dSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/JIX9t2j0ZTN9S/giphy.gif",
    EXPLORER_URL: "https://basescan.org/tx/"
};

// Initialize
console.log("🟢 Initializing ATM Rewards Bot...");
const bot = new Telegraf(config.TELEGRAM_TOKEN);
const provider = new ethers.JsonRpcProvider(config.RPC_URL);

// Contracts
const ATM_ABI = [
    "function totalDistributed() view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const USDC_ABI = [
    "function balanceOf(address) view returns (uint256)"
];

const atm = new ethers.Contract(config.CONTRACT_ADDRESS, ATM_ABI, provider);
const usdc = new ethers.Contract(config.USDC_ADDRESS, USDC_ABI, provider);

// State
let lastTotalDistributed = "0";
let lastProcessedBlock = 0;

async function sendWithGif(chatId, message, gifUrl) {
    try {
        console.log(`🖼 Sending GIF with message: ${message.substring(0, 50)}...`);
        await bot.telegram.sendAnimation(chatId, gifUrl, {
            caption: message,
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error("❌ Failed to send GIF:", error.message);
        // Fallback to text
        await bot.telegram.sendMessage(chatId, message, {
            parse_mode: 'Markdown'
        });
    }
}

async function initialize() {
    try {
        lastProcessedBlock = await provider.getBlockNumber();
        console.log(`📦 Initialized at block ${lastProcessedBlock}`);
        lastTotalDistributed = await atm.totalDistributed();
        console.log(`💵 Initial total distributed: $${ethers.formatUnits(lastTotalDistributed, 6)} USDC`);
    } catch (error) {
        console.error("🔴 Initialization failed:", error);
        process.exit(1);
    }
}

async function monitorRewardDistributions() {
    try {
        const currentBlock = await provider.getBlockNumber();
        console.log(`🔍 Checking blocks ${lastProcessedBlock} → ${currentBlock} for rewards...`);

        if (currentBlock > lastProcessedBlock) {
            const events = await atm.queryFilter(
                atm.filters.Transfer(config.CONTRACT_ADDRESS),
                lastProcessedBlock,
                currentBlock
            );

            console.log(`📊 Found ${events.length} reward distribution events`);

            for (const event of events) {
                const amount = ethers.formatUnits(event.args.value, 6);
                console.log(`🎁 New reward: $${amount} USDC to ${event.args.to}`);

                const message = `🎉 *New Reward Distributed!*\n\n` +
                    `💰 Amount: $${amount} USDC\n` +
                    `➡️ To: ${event.args.to}\n` +
                    `⏰ Time: ${new Date().toLocaleString()}\n` +
                    `[🔗 View TX](${config.EXPLORER_URL}${event.transactionHash})`;

                await sendWithGif(config.CHAT_ID, message, config.REWARD_GIF);
            }

            lastProcessedBlock = currentBlock;
        } else {
            console.log("⏭ No new blocks since last check");
        }
    } catch (error) {
        console.error("⚠️ Monitoring error:", error);
    }
}

async function sendUpdate() {
    try {
        console.log("🔄 Preparing stats update...");
        const [totalDistributed, contractBalance] = await Promise.all([
            atm.totalDistributed().then(d => ethers.formatUnits(d, 6)),
            usdc.balanceOf(config.CONTRACT_ADDRESS).then(b => ethers.formatUnits(b, 6))
        ]);

        const message =
            `🔄 *ATM Reward Update* (${new Date().toLocaleTimeString()})\n\n` +
            `💰 Total Distributed: $${parseFloat(totalDistributed).toFixed(2)} USDC\n` +
            `🏦 Contract Balance: $${parseFloat(contractBalance).toFixed(6)} USDC\n` +
            `⏱ Next Update: 15 minutes`;

        await sendWithGif(config.CHAT_ID, message, config.STATS_GIF);
        console.log("📤 Sent stats update to Telegram");
    } catch (error) {
        console.error("❌ Update failed:", error);
    }
}

async function startBot() {
    try {
        await initialize();
        await bot.launch();
        console.log("🤖 Bot started successfully");

        // Initial update
        await sendUpdate();

        // Schedule monitoring
        setInterval(monitorRewardDistributions, config.REWARD_CHECK_INTERVAL);
        setInterval(sendUpdate, config.UPDATE_INTERVAL);

        console.log(`⏰ Scheduled checks every ${config.REWARD_CHECK_INTERVAL / 1000}s`);
    } catch (error) {
        console.error("💥 Startup failed:", error);
        process.exit(1);
    }
}

startBot();

// Clean shutdown
process.once('SIGINT', () => {
    console.log("🛑 Shutting down gracefully...");
    bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    console.log("🛑 Terminating...");
    bot.stop('SIGTERM');
});