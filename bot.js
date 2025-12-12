require('dotenv').config();
const { Telegraf } = require('telegraf');
const { ethers } = require('ethers');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Configuration
const config = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    CHAT_ID: process.env.CHAT_ID,
    RPC_URL: process.env.RPC_URL,
    CONTRACT_ADDRESS: "0x2cFa3EAb79E5CfE34EAabfb6aCaAC0Da0565Aa77",
    REWARD_TOKEN_ADDRESS: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", // USDC on MONAD
    UPDATE_INTERVAL: 420000,  // 7 minutes (matches contract REWARD_INTERVAL)
    REWARD_CHECK_INTERVAL: 420000,  // 7 minutes
    REWARD_GIF: "./IMG_0363.MP4",
    STATS_GIF: "./IMG_0363.MP4",
    EXPLORER_URL: "https://monadscan.com/",
    MIN_REWARD_AMOUNT: 0.000001  // Minimum 0.01 USDC to notify
};

// Initialize
console.log("🟢 Initializing BASED_BOT USDC Rewards Bot...");
const bot = new Telegraf(config.TELEGRAM_TOKEN);
const provider = new ethers.JsonRpcProvider(config.RPC_URL);

// Health check server
const app = express();
app.get('/', (req, res) => res.send('Bot is healthy'));
const server = app.listen(process.env.PORT || 3000, () => {
    console.log(`⚡ Health check running on port ${process.env.PORT || 3000}`);
});

// Check if local GIF files exist
function checkLocalFiles() {
    const filesToCheck = [
        { path: config.REWARD_GIF, name: 'Reward GIF' },
        { path: config.STATS_GIF, name: 'Stats GIF' }
    ];

    filesToCheck.forEach(file => {
        if (fs.existsSync(file.path)) {
            console.log(`✅ ${file.name} found: ${file.path}`);
        } else {
            console.log(`❌ ${file.name} not found: ${file.path}`);
            console.log(`💡 Please place ${file.name} in the bot's root directory`);
        }
    });
}

// Contracts - Updated ABI for USDC rewards
const BASED_BOT_ABI = [
    "function totalRewardsDistributed() view returns (uint256)",
    "function accumulatedRewardPool() view returns (uint256)",
    "function getRewardInfo() view returns (uint256, uint256, uint256, uint256, uint256)",
    "function getHolderCount() view returns (uint256)",
    "event RewardDistributed(address indexed user, uint256 amount)",
    "event AutoDistribution(uint256 totalDistributed, uint256 holderCount)",
    "event RewardsAccumulated(uint256 usdcAmount)"
];

const USDC_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function transfer(address, uint256) returns (bool)"
];

const BASED_BOT = new ethers.Contract(config.CONTRACT_ADDRESS, BASED_BOT_ABI, provider);
const USDC_TOKEN = new ethers.Contract(config.REWARD_TOKEN_ADDRESS, USDC_ABI, provider);

// State
let lastTotalRewardsDistributed = "0";
let lastProcessedBlock = 0;
let usdcDecimals = 6; // USDC has 6 decimals
let tokenSymbol = "USDC";
let processedTransactions = new Set();
let processedRewardEvents = new Set();

// ======================
// CORE FUNCTIONS
// ======================

// Function to get UTC time string
function getUTCTimeString() {
    const now = new Date();
    return now.toUTCString();
}

// Function to get UTC time for logging
function getUTCTimeForLog() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
}

async function sendWithGif(chatId, message, gifPath) {
    try {
        console.log(`📤 Sending to Telegram: ${message.substring(0, 30)}...`);
        
        if (fs.existsSync(gifPath)) {
            await bot.telegram.sendAnimation(chatId, 
                { source: fs.readFileSync(gifPath) }, 
                {
                    caption: message,
                    parse_mode: 'Markdown'
                }
            );
            console.log('✅ Telegram message with local GIF sent!');
        } else {
            console.log('⚠️ Local GIF not found, sending text only');
            await bot.telegram.sendMessage(chatId, message, {
                parse_mode: 'Markdown'
            });
        }
    } catch (error) {
        console.error('❌ Telegram send failed:', error.message);
        
        // Fallback to text message
        try {
            await bot.telegram.sendMessage(chatId, message, {
                parse_mode: 'Markdown'
            });
            console.log('✅ Fallback text message sent!');
        } catch (textError) {
            console.error('💥 Text fallback also failed:', textError.message);
        }
    }
}

async function verifyTokenDetails() {
    try {
        const [symbol, decimals] = await Promise.all([
            USDC_TOKEN.symbol(),
            USDC_TOKEN.decimals()
        ]);
        console.log(`ℹ️ Reward token verified: ${symbol} with ${decimals} decimals`);
        return { symbol, decimals };
    } catch (error) {
        console.error('⚠️ Failed to get USDC details, using defaults');
        return { symbol: "USDC", decimals: 6 };
    }
}

async function monitorRewardDistributions() {
    try {
        const utcTime = getUTCTimeForLog();
        console.log(`\n[${utcTime}] 🔄 Checking USDC rewards...`);

        const currentBlock = await provider.getBlockNumber();
        
        // Only check recent blocks to avoid too many events
        const fromBlock = Math.max(lastProcessedBlock, currentBlock - 1000);
        
        console.log(`🔍 Scanning blocks ${fromBlock} → ${currentBlock}`);

        if (currentBlock > fromBlock) {
            // Get ALL events from the contract to see what's actually being emitted
            const allEvents = await BASED_BOT.queryFilter("*", fromBlock, currentBlock);
            console.log(`📊 Found ${allEvents.length} total events from contract`);

            // Listen for RewardDistributed events
            const rewardEvents = await BASED_BOT.queryFilter(
                BASED_BOT.filters.RewardDistributed(),
                fromBlock,
                currentBlock
            );

            console.log(`🎯 Found ${rewardEvents.length} RewardDistributed events`);

            // Also check for AutoDistribution events
            const autoDistributionEvents = await BASED_BOT.queryFilter(
                BASED_BOT.filters.AutoDistribution(),
                fromBlock,
                currentBlock
            );

            console.log(`🔄 Found ${autoDistributionEvents.length} AutoDistribution events`);

            let rewardCount = 0;
            let totalDistributedThisCycle = 0;
            
            // Process RewardDistributed events
            for (const event of rewardEvents) {
                try {
                    const eventKey = `${event.transactionHash}_${event.logIndex}`;
                    
                    // Skip if already processed
                    if (processedRewardEvents.has(eventKey)) {
                        console.log(`⏩ Skipping already processed reward event: ${eventKey}`);
                        continue;
                    }

                    const user = event.args.user;
                    const amount = event.args.amount;

                    // Format and validate amount
                    const formattedAmount = ethers.formatUnits(amount, usdcDecimals);
                    const displayAmount = parseFloat(formattedAmount);

                    console.log(`🔍 Processing reward event: ${displayAmount} USDC to ${user}`);

                    // Skip if below minimum threshold (now very low)
                    if (displayAmount < config.MIN_REWARD_AMOUNT) {
                        console.log(`⏩ Skipping very small reward: ${displayAmount.toFixed(6)} ${tokenSymbol}`);
                        continue;
                    }

                    console.log(`💵 ✅ VALID REWARD DETECTED: ${displayAmount.toFixed(6)} ${tokenSymbol} to ${user}`);

                    const message = `🎉 *New USDC Reward Distributed!*\n\n` +
                        `💰 Amount: ${displayAmount.toFixed(6)} ${tokenSymbol}\n` +
                        `👤 To: \`${user}\`\n` +
                        `⏰ Time: ${getUTCTimeString()}\n` +
                        `[🔗 View TX](${config.EXPLORER_URL}${event.transactionHash})`;

                    await sendWithGif(config.CHAT_ID, message, config.REWARD_GIF);
                    
                    // Mark as processed
                    processedRewardEvents.add(eventKey);
                    rewardCount++;
                    totalDistributedThisCycle += displayAmount;

                    console.log(`✅ Successfully notified reward to ${user}`);

                    // Small delay between notifications to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                } catch (eventError) {
                    console.error('⚠️ Error processing reward event:', eventError);
                }
            }

            // Process AutoDistribution events - notify even for small amounts since it's a summary
            for (const event of autoDistributionEvents) {
                try {
                    const eventKey = `auto_${event.transactionHash}_${event.logIndex}`;
                    
                    if (processedRewardEvents.has(eventKey)) {
                        continue;
                    }

                    const totalDistributed = event.args.totalDistributed;
                    const holderCount = event.args.holderCount;

                    const formattedTotal = ethers.formatUnits(totalDistributed, usdcDecimals);
                    const displayTotal = parseFloat(formattedTotal);

                    console.log(`🔍 Processing auto distribution: ${displayTotal} USDC to ${holderCount} holders`);

                    // Always notify auto distribution events as they're summaries
                    const message = `🚀 *Auto Distribution Completed!*\n\n` +
                        `💰 Total Distributed: ${displayTotal.toFixed(6)} ${tokenSymbol}\n` +
                        `👥 Holders Rewarded: ${holderCount}\n` +
                        `⏰ Time: ${getUTCTimeString()}\n` +
                        `[🔗 View TX](${config.EXPLORER_URL}${event.transactionHash})`;

                    await sendWithGif(config.CHAT_ID, message, config.REWARD_GIF);
                    processedRewardEvents.add(eventKey);
                    rewardCount++;
                    console.log(`✅ Notified auto distribution to ${holderCount} holders`);

                } catch (autoError) {
                    console.error('⚠️ Error processing auto distribution event:', autoError);
                }
            }

            console.log(`✅ Processed ${rewardCount} new reward events, total: ${totalDistributedThisCycle.toFixed(6)} USDC`);
            lastProcessedBlock = currentBlock;

            // Clean up old events from memory (keep last 1000)
            if (processedRewardEvents.size > 1000) {
                const array = Array.from(processedRewardEvents);
                processedRewardEvents = new Set(array.slice(-500));
            }

            // Send summary if we processed multiple individual rewards
            if (rewardCount > 1 && totalDistributedThisCycle > 0) {
                const summaryMessage = `📊 *Distribution Summary*\n\n` +
                    `💰 Total Distributed: ${totalDistributedThisCycle.toFixed(6)} ${tokenSymbol}\n` +
                    `👥 Rewards Sent: ${rewardCount}\n` +
                    `⏰ Period: ${getUTCTimeString()}`;
                
                await sendWithGif(config.CHAT_ID, summaryMessage, config.REWARD_GIF);
            }
        }
    } catch (error) {
        console.error('⚠️ Reward check failed:', error);
    }
}
async function sendStatsUpdate() {
    try {
        console.log("\n📈 Preparing USDC stats update...");
        
        // Get all the necessary data
        const [
            totalRewardsDistributed,
            accumulatedRewardPool,
            contractUSDCBalance,
            holderCount
        ] = await Promise.all([
            BASED_BOT.totalRewardsDistributed(),
            BASED_BOT.accumulatedRewardPool(),
            USDC_TOKEN.balanceOf(config.CONTRACT_ADDRESS),
            BASED_BOT.getHolderCount()
        ]);

        console.log('📊 Raw contract data:', {
            totalRewardsDistributed: totalRewardsDistributed.toString(),
            accumulatedRewardPool: accumulatedRewardPool.toString(),
            contractUSDCBalance: contractUSDCBalance.toString(),
            holderCount: holderCount.toString()
        });

        // Convert all values properly
        const totalDistributed = parseFloat(ethers.formatUnits(totalRewardsDistributed, usdcDecimals));
        const accumulatedPool = parseFloat(ethers.formatUnits(accumulatedRewardPool, usdcDecimals));
        const contractBalance = parseFloat(ethers.formatUnits(contractUSDCBalance, usdcDecimals));
        const holders = Number(holderCount);

        console.log('📊 Formatted data:', {
            totalDistributed,
            accumulatedPool,
            contractBalance,
            holders
        });

        // Format numbers properly - use more decimals for small amounts
        function formatUSDC(amount) {
            if (amount === 0) return "0.00";
            if (amount < 0.01) return amount.toFixed(6); // Show more decimals for small amounts
            if (amount < 1) return amount.toFixed(4);    // 4 decimals for amounts under 1
            return amount.toFixed(2);                    // 2 decimals for larger amounts
        }

        const message =
            `🔄 *TRASHY_BOT USDC Reward Update*\n\n` +
            `💰 Total Distributed: ${formatUSDC(totalDistributed)} ${tokenSymbol}\n` +
            `🏦 Contract Balance: ${formatUSDC(contractBalance)} ${tokenSymbol}\n` +
            `📥 Ready for Distribution: ${formatUSDC(accumulatedPool)} ${tokenSymbol}\n` +
            `👥 Total Holders: ${holders}\n` +
            `⏰ Updated: ${getUTCTimeString()}`;

        await sendWithGif(config.CHAT_ID, message, config.STATS_GIF);
        console.log('✅ Stats update sent successfully!');
        
    } catch (error) {
        console.error('❌ Stats update failed:', error);
        console.error('Error details:', error.message);
        
        // Enhanced fallback with simpler stats
        try {
            const [totalRewards, contractBalance] = await Promise.all([
                BASED_BOT.totalRewardsDistributed(),
                USDC_TOKEN.balanceOf(config.CONTRACT_ADDRESS)
            ]);

            const totalFormatted = parseFloat(ethers.formatUnits(totalRewards, usdcDecimals));
            const balanceFormatted = parseFloat(ethers.formatUnits(contractBalance, usdcDecimals));

            function formatFallback(amount) {
                if (amount === 0) return "0.00";
                if (amount < 0.01) return amount.toFixed(6);
                if (amount < 1) return amount.toFixed(4);
                return amount.toFixed(2);
            }

            const fallbackMessage =
                `🔄 *BASED_BOT USDC Reward Update*\n\n` +
                `💰 Total Distributed: ${formatFallback(totalFormatted)} ${tokenSymbol}\n` +
                `🏦 Contract Balance: ${formatFallback(balanceFormatted)} ${tokenSymbol}\n` +
                `⏰ Updated: ${getUTCTimeString()}\n\n` +
                `ℹ️ Some stats temporarily unavailable`;

            await sendWithGif(config.CHAT_ID, fallbackMessage, config.STATS_GIF);
            console.log('✅ Fallback stats update sent!');
        } catch (fallbackError) {
            console.error('💥 Fallback also failed:', fallbackError.message);
        }
    }
}
// ======================
// BOT CONTROL
// ======================
async function startBot() {
    try {
        console.log("\n🔌 Testing connections...");
        
        // Check local files first
        checkLocalFiles();
        
        const block = await provider.getBlockNumber();
        console.log(`✅ Blockchain connected (Block ${block})`);

        // Verify token details
        const tokenDetails = await verifyTokenDetails();
        tokenSymbol = tokenDetails.symbol;
        usdcDecimals = tokenDetails.decimals;

        console.log("✅ Telegram connection working");

        // Initial data load
        lastTotalRewardsDistributed = await BASED_BOT.totalRewardsDistributed();
        lastProcessedBlock = block;
        const initialTotal = ethers.formatUnits(lastTotalRewardsDistributed, usdcDecimals);
        console.log(`💰 Initial total rewards distributed: ${initialTotal} ${tokenSymbol}`);

        // Start monitoring with reduced frequency
        console.log("\n🚀 Starting USDC reward monitoring...");
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