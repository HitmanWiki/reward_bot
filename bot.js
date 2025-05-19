require('dotenv').config();
const { Telegraf } = require('telegraf');
const { ethers } = require('ethers');

// ======================
// CONFIGURATION
// ======================
const config = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    CHAT_ID: process.env.CHAT_ID,
    RPC_URL: process.env.RPC_URL,
    CONTRACT_ADDRESS: "0x88807fDabF60fdDd7bd8fB4987dC5A63cbd31f6a",
    USDC_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    UPDATE_INTERVAL: 900000, // 15 minutes
    REWARD_CHECK_INTERVAL: 60000, // 1 minute
    REWARD_GIF: process.env.REWARD_GIF,
    STATS_GIF: process.env.STATS_GIF,
    EXPLORER_URL: "https://basescan.org/tx/"
};

// ======================
// INITIALIZATION
// ======================
console.log("🟢 Initializing ATM Rewards Bot...");
const bot = new Telegraf(config.TELEGRAM_TOKEN);
const provider = new ethers.JsonRpcProvider(config.RPC_URL);

// Minimal health check server
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is healthy'));
const server = app.listen(process.env.PORT || 3000, () => {
    console.log(`⚡ Health check running on port ${process.env.PORT || 3000}`);
});

// Contracts
const ITM_ABI = [
    "function totalDistributed() view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const USDC_ABI = [
    "function balanceOf(address) view returns (uint256)"
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
        await bot.telegram.sendAnimation(chatId, gifUrl, {
            caption: message,
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error("Failed to send GIF, falling back to text:", error.message);
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
        console.error("Initialization failed:", error);
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
        console.error("Reward monitoring error:", error);
    }
}

async function sendStatsUpdate() {
    try {
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
    } catch (error) {
        console.error("Stats update failed:", error);
    }
}

// ======================
// PROCESS MANAGEMENT
// ======================
async function shutdown() {
    console.log('🛑 Beginning graceful shutdown...');
    try {
        server.close();
        await bot.stop();
        console.log('✅ Shutdown complete');
        process.exit(0);
    } catch (err) {
        console.error('Shutdown error:', err);
        process.exit(1);
    }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ======================
// BOT STARTUP
// ======================
async function startBot() {
    try {
        await initialize();
        await bot.launch();
        console.log("🤖 Bot started successfully");

        await sendStatsUpdate();

        setInterval(monitorRewardDistributions, config.REWARD_CHECK_INTERVAL);
        setInterval(sendStatsUpdate, config.UPDATE_INTERVAL);

    } catch (error) {
        console.error("Startup failed:", error);
        process.exit(1);
    }
}

startBot();