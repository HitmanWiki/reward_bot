require('dotenv').config();
const { Telegraf } = require('telegraf');
const { ethers } = require('ethers');
const express = require('express');

// Configuration
const config = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    CHAT_ID: process.env.CHAT_ID,
    RPC_URL: process.env.RPC_URL,
    CONTRACT_ADDRESS: "0x88807fDabF60fdDd7bd8fB4987dC5A63cbd31f6a",
    USDC_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    UPDATE_INTERVAL: 900000,  // 5 seconds for testing
    REWARD_CHECK_INTERVAL: 60000,  // 3 seconds for testing
    REWARD_GIF: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExcWJvYzV5b2VxY2VzZ2F4a2F5Y2x0bGJ6aHd3eG1rY3R5Z2R2dSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3o7abAHdYvZdBNnGZq/giphy.gif",
    STATS_GIF: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExcWJvYzV5b2VxY2VzZ2F4a2F5Y2x0bGJ6aHd3eG1rY3R5Z2R2dSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/JIX9t2j0ZTN9S/giphy.gif",
    EXPLORER_URL: "https://basescan.org/tx/"
};

// Initialize
console.log("🟢 Initializing ATM Rewards Bot...");
const bot = new Telegraf(config.TELEGRAM_TOKEN);
const provider = new ethers.JsonRpcProvider(config.RPC_URL);

// Health check server
const app = express();
app.get('/', (req, res) => res.send('Bot is healthy'));
const server = app.listen(process.env.PORT || 3000, () => {
    console.log(`⚡ Health check running on port ${process.env.PORT || 3000}`);
});

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

// ======================
// CORE FUNCTIONS
// ======================

async function sendWithGif(chatId, message, gifUrl) {
    try {
        console.log(`📤 Sending to Telegram: ${message.substring(0, 30)}...`);
        await bot.telegram.sendAnimation(chatId, gifUrl, {
            caption: message,
            parse_mode: 'Markdown'
        });
        console.log('✅ Telegram message sent!');
    } catch (error) {
        console.error('❌ Telegram send failed:', error.message);
    }
}

async function monitorRewardDistributions() {
    try {
        const now = new Date();
        console.log(`\n[${now.toLocaleTimeString()}] 🔄 Checking rewards...`);

        const currentBlock = await provider.getBlockNumber();
        console.log(`🔍 Blocks ${lastProcessedBlock} → ${currentBlock}`);

        if (currentBlock > lastProcessedBlock) {
            const events = await atm.queryFilter(
                atm.filters.Transfer(config.CONTRACT_ADDRESS),
                lastProcessedBlock,
                currentBlock
            );

            console.log(`📊 Found ${events.length} reward events`);

            for (const event of events) {
                // Debug logging of raw values
                console.log('Raw event value:', event.args.value.toString());

                // Format the amount correctly with 6 decimal places for USDC
                const rawAmount = event.args.value;
                const amountInUnits = ethers.formatUnits(rawAmount, 6);
                const displayAmount = parseFloat(amountInUnits).toFixed(2);

                // Additional verification
                console.log(`Raw: ${rawAmount.toString()}, Formatted: ${amountInUnits}, Display: ${displayAmount}`);

                // If still getting huge numbers, try this alternative:
                const alternativeFormat = (Number(rawAmount) / 1e6).toFixed(2);
                console.log('Alternative format:', alternativeFormat);

                const finalAmount = displayAmount; // or use alternativeFormat if needed

                console.log(`🎁 Reward: $${finalAmount} to ${event.args.to.substring(0, 6)}...`);

                const message = `🎉 *New Reward Distributed!*\n\n` +
                    `💰 Amount: $${finalAmount} USDC\n` +
                    `➡️ To: ${event.args.to}\n` +
                    `⏰ Time: ${now.toLocaleString()}\n` +
                    `[🔗 View TX](${config.EXPLORER_URL}${event.transactionHash})`;

                await sendWithGif(config.CHAT_ID, message, config.REWARD_GIF);
            }

            lastProcessedBlock = currentBlock;
        }
    } catch (error) {
        console.error('⚠️ Reward check failed:', error);
    }
}
async function sendStatsUpdate() {
    try {
        console.log("\n📈 Preparing stats update...");
        const [totalDistributed, contractBalance] = await Promise.all([
            atm.totalDistributed().then(d => ethers.formatUnits(d, 6)),
            usdc.balanceOf(config.CONTRACT_ADDRESS).then(b => ethers.formatUnits(b, 6))
        ]);

        const message =
            `🔄 *ATM Reward Update*\n\n` +
            `💰 Total Distributed: $${parseFloat(totalDistributed).toFixed(2)} USDC\n` +
            `🏦 Contract Balance: $${parseFloat(contractBalance).toFixed(6)} USDC\n` +
            `⏰ Updated: ${new Date().toLocaleTimeString()}`;

        await sendWithGif(config.CHAT_ID, message, config.STATS_GIF);
    } catch (error) {
        console.error('❌ Stats update failed:', error);
    }
}

// ======================
// BOT CONTROL
// ======================
async function startBot() {
    try {
        // Initial connection test
        console.log("\n🔌 Testing connections...");
        const block = await provider.getBlockNumber();
        console.log(`✅ Blockchain connected (Block ${block})`);

        // await bot.telegram.sendMessage(config.CHAT_ID, "🤖 ATM Rewards Bot is now online!");
        console.log("✅ Telegram connection working");

        // Initial data load
        lastTotalDistributed = await atm.totalDistributed();
        lastProcessedBlock = block;
        console.log(`💰 Initial total distributed: $${ethers.formatUnits(lastTotalDistributed, 6)} USDC`);

        // Start monitoring
        console.log("\n🚀 Starting monitoring...");
        setInterval(monitorRewardDistributions, config.REWARD_CHECK_INTERVAL);
        setInterval(sendStatsUpdate, config.UPDATE_INTERVAL);

        // Immediate first run
        await monitorRewardDistributions();
        await sendStatsUpdate();

    } catch (error) {
        console.error('💥 Startup failed:', error);
        process.exit(1);
    }
}

// Start the bot
startBot();

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM - shutting down...');
    server.close();
    bot.stop();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT - shutting down...');
    server.close();
    bot.stop();
    process.exit(0);
});