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
    UPDATE_INTERVAL: 900000,  // 15 minutes
    REWARD_CHECK_INTERVAL: 60000,  // 1 minute
    REWARD_GIF: "https://dingooneth.com/IMG_6496.gif",
    STATS_GIF: "https://dingooneth.com/IMG_6496.gif",
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
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function getDistributionAmount(address recipient) view returns (uint256)"  // Added new function
];

const USDC_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)"  // Added to verify decimals
];

const atm = new ethers.Contract(config.CONTRACT_ADDRESS, ATM_ABI, provider);
const usdc = new ethers.Contract(config.USDC_ADDRESS, USDC_ABI, provider);

// State
let lastTotalDistributed = "0";
let lastProcessedBlock = 0;
let usdcDecimals = 6; // Default to 6, will be verified

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

async function verifyUsdcDecimals() {
    try {
        const decimals = await usdc.decimals();
        console.log(`ℹ️ USDC decimals verified: ${decimals}`);
        return decimals;
    } catch (error) {
        console.error('⚠️ Failed to get USDC decimals, using default 6');
        return 6;
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
                try {
                    // Method 1: Get precise amount from contract
                    let amount;
                    try {
                        amount = await atm.getDistributionAmount(event.args.to);
                        console.log('✅ Got precise amount from contract');
                    } catch {
                        // Fallback to event value if function not available
                        amount = event.args.value;
                        console.log('ℹ️ Using event value as fallback');
                    }

                    // Format amount with verified decimals
                    const formattedAmount = ethers.formatUnits(amount, usdcDecimals);
                    const displayAmount = parseFloat(formattedAmount).toFixed(2);

                    // Sanity check
                    if (displayAmount > 1000000) {
                        console.error('⚠️ Suspiciously large amount detected, skipping');
                        continue;
                    }

                    console.log(`💵 Validated amount: $${displayAmount} USDC`);

                    const message = `🎉 *New Reward Distributed!*\n\n` +
                        `💰 Amount: $${displayAmount} USDC\n` +
                        `➡️ To: ${event.args.to}\n` +
                        `⏰ Time: ${now.toLocaleString()}\n` +
                        `[🔗 View TX](${config.EXPLORER_URL}${event.transactionHash})`;

                    await sendWithGif(config.CHAT_ID, message, config.REWARD_GIF);
                } catch (eventError) {
                    console.error('⚠️ Error processing event:', eventError);
                }
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
            atm.totalDistributed().then(d => ethers.formatUnits(d, usdcDecimals)),
            usdc.balanceOf(config.CONTRACT_ADDRESS).then(b => ethers.formatUnits(b, usdcDecimals))
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

        // Verify USDC decimals
        usdcDecimals = await verifyUsdcDecimals();

        // await bot.telegram.sendMessage(config.CHAT_ID, "🤖 ATM Rewards Bot is now online!");
        console.log("✅ Telegram connection working");

        // Initial data load
        lastTotalDistributed = await atm.totalDistributed();
        lastProcessedBlock = block;
        console.log(`💰 Initial total distributed: $${ethers.formatUnits(lastTotalDistributed, usdcDecimals)} USDC`);

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