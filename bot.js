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
    BASE_ETH_ADDRESS: "0x4200000000000000000000000000000000000006", // WETH on Base
    UPDATE_INTERVAL: 500,  // 15 minutes (in milliseconds)
    REWARD_CHECK_INTERVAL: 120000,  // 2 minutes (reduced frequency)
    REWARD_GIF: "https://dingooneth.com/IMG_6496.gif",
    STATS_GIF: "https://dingooneth.com/IMG_6496.gif",
    EXPLORER_URL: "https://basescan.org/tx/",
    MIN_REWARD_AMOUNT: 0.0001  // Minimum 0.0001 ETH to notify
};

// Initialize
console.log("🟢 Initializing BASED_BOT Rewards Bot...");
const bot = new Telegraf(config.TELEGRAM_TOKEN);
const provider = new ethers.JsonRpcProvider(config.RPC_URL);

// Health check server
const app = express();
app.get('/', (req, res) => res.send('Bot is healthy'));
const server = app.listen(process.env.PORT || 3000, () => {
    console.log(`⚡ Health check running on port ${process.env.PORT || 3000}`);
});

// Contracts
const BASED_BOT_ABI = [
    "function totalDistributed() view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function getDistributionAmount(address recipient) view returns (uint256)"
];

const WETH_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
];

const BASED_BOT = new ethers.Contract(config.CONTRACT_ADDRESS, BASED_BOT_ABI, provider);
const baseEth = new ethers.Contract(config.BASE_ETH_ADDRESS, WETH_ABI, provider);

// State
let lastTotalDistributed = "0";
let lastProcessedBlock = 0;
let ethDecimals = 18; // ETH/WETH always has 18 decimals
let tokenSymbol = "ETH";
let processedTransactions = new Set();

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

async function verifyTokenDetails() {
    try {
        const [symbol, decimals] = await Promise.all([
            baseEth.symbol(),
            baseEth.decimals()
        ]);
        console.log(`ℹ️ Token verified: ${symbol} with ${decimals} decimals`);
        return { symbol, decimals };
    } catch (error) {
        console.error('⚠️ Failed to get token details, using defaults');
        return { symbol: "ETH", decimals: 18 };
    }
}

async function monitorRewardDistributions() {
    try {
        const now = new Date();
        console.log(`\n[${now.toLocaleTimeString()}] 🔄 Checking rewards...`);

        const currentBlock = await provider.getBlockNumber();
        
        // Only check recent blocks to avoid too many events
        const fromBlock = Math.max(lastProcessedBlock, currentBlock - 100);
        
        console.log(`🔍 Blocks ${fromBlock} → ${currentBlock}`);

        if (currentBlock > fromBlock) {
            const events = await BASED_BOT.queryFilter(
                BASED_BOT.filters.Transfer(config.CONTRACT_ADDRESS),
                fromBlock,
                currentBlock
            );

            console.log(`📊 Found ${events.length} transfer events`);

            let rewardCount = 0;
            
            for (const event of events) {
                try {
                    // Skip if already processed
                    if (processedTransactions.has(event.transactionHash)) {
                        console.log(`⏩ Skipping already processed TX: ${event.transactionHash}`);
                        continue;
                    }

                    // Skip zero-value transfers
                    if (event.args.value === 0n) {
                        console.log(`⏩ Skipping zero value transfer`);
                        continue;
                    }

                    // Get amount with fallback
                    let amount;
                    try {
                        amount = await BASED_BOT.getDistributionAmount(event.args.to);
                        console.log('✅ Got precise amount from contract');
                    } catch {
                        amount = event.args.value;
                        console.log('ℹ️ Using event value as fallback');
                    }

                    // Format and validate amount
                    const formattedAmount = ethers.formatUnits(amount, ethDecimals);
                    const displayAmount = parseFloat(formattedAmount);

                    // Skip if below minimum threshold
                    if (displayAmount < config.MIN_REWARD_AMOUNT) {
                        console.log(`⏩ Skipping small amount: ${displayAmount} ${tokenSymbol}`);
                        continue;
                    }

                    // Sanity check for suspiciously large amounts
                    if (displayAmount > 1000) { // More than 1000 ETH is suspicious
                        console.error('⚠️ Suspiciously large amount detected, skipping');
                        continue;
                    }

                    console.log(`💵 Valid reward: ${displayAmount.toFixed(6)} ${tokenSymbol} to ${event.args.to.substring(0, 8)}...`);

                    const message = `🎉 *New Reward Distributed!*\n\n` +
                        `💰 Amount: ${displayAmount.toFixed(6)} ${tokenSymbol}\n` +
                        `➡️ To: \`${event.args.to}\`\n` +
                        `⏰ Time: ${now.toLocaleString()}\n` +
                        `[🔗 View TX](${config.EXPLORER_URL}${event.transactionHash})`;

                    await sendWithGif(config.CHAT_ID, message, config.REWARD_GIF);
                    
                    // Mark as processed
                    processedTransactions.add(event.transactionHash);
                    rewardCount++;

                    // Small delay between notifications to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                } catch (eventError) {
                    console.error('⚠️ Error processing event:', eventError);
                }
            }

            console.log(`✅ Processed ${rewardCount} new rewards`);
            lastProcessedBlock = currentBlock;

            // Clean up old transactions from memory (keep last 1000)
            if (processedTransactions.size > 1000) {
                const array = Array.from(processedTransactions);
                processedTransactions = new Set(array.slice(-500));
            }
        }
    } catch (error) {
        console.error('⚠️ Reward check failed:', error);
    }
}

async function sendStatsUpdate() {
    try {
        console.log("\n📈 Preparing stats update...");
        const [totalDistributed, contractBalance] = await Promise.all([
            BASED_BOT.totalDistributed().then(d => ethers.formatUnits(d, ethDecimals)),
            baseEth.balanceOf(config.CONTRACT_ADDRESS).then(b => ethers.formatUnits(b, ethDecimals))
        ]);

        const message =
            `🔄 *BASED_BOT Reward Update*\n\n` +
            `💰 Total Distributed: ${parseFloat(totalDistributed).toFixed(6)} ${tokenSymbol}\n` +
            `🏦 Contract Balance: ${parseFloat(contractBalance).toFixed(6)} ${tokenSymbol}\n` +
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
        console.log("\n🔌 Testing connections...");
        const block = await provider.getBlockNumber();
        console.log(`✅ Blockchain connected (Block ${block})`);

        // Verify token details
        const tokenDetails = await verifyTokenDetails();
        tokenSymbol = tokenDetails.symbol;
        ethDecimals = tokenDetails.decimals;

        console.log("✅ Telegram connection working");

        // Initial data load
        lastTotalDistributed = await BASED_BOT.totalDistributed();
        lastProcessedBlock = block;
        console.log(`💰 Initial total distributed: ${ethers.formatUnits(lastTotalDistributed, ethDecimals)} ${tokenSymbol}`);

        // Start monitoring with reduced frequency
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