require('dotenv').config();
const { Telegraf } = require('telegraf');
const { ethers } = require('ethers');
const express = require('express');

// ======================
// CONFIGURATION
// ======================
const config = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    CHAT_ID: process.env.CHAT_ID,
    RPC_URL: process.env.RPC_URL || "https://base-mainnet.infura.io/v3/YOUR_INFURA_KEY",
    CONTRACT_ADDRESS: "0x88807fDabF60fdDd7bd8fB4987dC5A63cbd31f6a",
    USDC_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    UPDATE_INTERVAL: 900000, // 15 minutes
    REWARD_CHECK_INTERVAL: 60000, // 1 minute
    REWARD_GIF: process.env.REWARD_GIF || "https://media.giphy.com/media/REWARD_GIF_URL/giphy.gif",
    STATS_GIF: process.env.STATS_GIF || "https://media.giphy.com/media/STATS_GIF_URL/giphy.gif",
    EXPLORER_URL: "https://basescan.org/tx/"
};

// ======================
// INITIALIZATION
// ======================
console.log("🟢 Initializing ATM Rewards Bot...");

// Health check server (required for Heroku)
const healthApp = express();
healthApp.get('/', (req, res) => res.send('ATM Rewards Bot is operational'));
const server = healthApp.listen(process.env.PORT || 3000, () => {
    console.log(`⚡ Health check running on port ${process.env.PORT || 3000}`);
});

const bot = new Telegraf(config.TELEGRAM_TOKEN);
const provider = new ethers.JsonRpcProvider(config.RPC_URL);

// Contract ABIs
const ITM_ABI = [
    "function totalDistributed() view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const USDC_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

const itm = new ethers.Contract(config.CONTRACT_ADDRESS, ITM_ABI, provider);
const usdc = new ethers.Contract(config.USDC_ADDRESS, USDC_ABI, provider);

// ======================
// BOT STATE
// ======================
let lastTotalDistributed = "0";
let lastProcessedBlock = 0;

// ======================
// CORE FUNCTIONS
// ======================

async function sendWithGif(chatId, message, gifUrl) {
    try {
        console.log(`📤 Sending message with GIF: ${message.substring(0, 30)}...`);
        await bot.telegram.sendAnimation(chatId, gifUrl, {
            caption: message,
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error("❌ GIF send failed, falling back to text:", error.message);
        await bot.telegram.sendMessage(chatId, message, {
            parse_mode: 'Markdown'
        });
    }
}

async function initialize() {
    try {
        lastProcessedBlock = await provider.getBlockNumber();
        console.log(`📦 Initialized at block ${lastProcessedBlock}`);

        lastTotalDistributed = await itm.totalDistributed();
        console.log(`💰 Initial total distributed: $${ethers.formatUnits(lastTotalDistributed, 6)} USDC`);
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
            const events = await itm.queryFilter(
                itm.filters.Transfer(config.CONTRACT_ADDRESS),
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
        }
    } catch (error) {
        console.error("⚠️ Reward monitoring error:", error);
    }
}

async function sendStatsUpdate() {
    try {
        console.log("🔄 Preparing stats update...");
        const [totalDistributed, contractBalance] = await Promise.all([
            itm.totalDistributed().then(d => ethers.formatUnits(d, 6)),
            usdc.balanceOf(config.CONTRACT_ADDRESS).then(b => ethers.formatUnits(b, 6))
        ]);

        const message =
            `🔄 *ITM Reward Update* (${new Date().toLocaleTimeString()})\n\n` +
            `💰 Total Distributed: $${parseFloat(totalDistributed).toFixed(2)} USDC\n` +
            `🏦 Contract Balance: $${parseFloat(contractBalance).toFixed(6)} USDC\n` +
            `⏱ Next Update: 15 minutes`;

        await sendWithGif(config.CHAT_ID, message, config.STATS_GIF);
        console.log("✅ Stats update sent");
    } catch (error) {
        console.error("❌ Stats update failed:", error);
    }
}

// ======================
// PROCESS MANAGEMENT
// ======================

async function gracefulShutdown() {
    console.log('🛑 Beginning graceful shutdown...');
    try {
        // Close health check server
        server.close(() => {
            console.log('🌐 Health server closed');
        });

        // Stop Telegram bot
        await bot.stop();
        console.log('🤖 Bot stopped gracefully');

        process.exit(0);
    } catch (err) {
        console.error('🔥 Emergency shutdown:', err);
        process.exit(1);
    }
}

process.on('SIGTERM', gracefulShutdown); // Heroku uses this
process.on('SIGINT', gracefulShutdown);  // Ctrl+C uses this

// ======================
// BOT STARTUP
// ======================

async function startBot() {
    try {
        await initialize();
        await bot.launch();
        console.log("🤖 Bot started successfully");

        // Initial update
        await sendStatsUpdate();

        // Schedule monitoring
        setInterval(monitorRewardDistributions, config.REWARD_CHECK_INTERVAL);
        setInterval(sendStatsUpdate, config.UPDATE_INTERVAL);

        console.log(`⏰ Scheduled checks every ${config.REWARD_CHECK_INTERVAL / 1000}s`);
    } catch (error) {
        console.error("💥 Bot startup failed:", error);
        process.exit(1);
    }
}

startBot();