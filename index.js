require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Redis } = require('@upstash/redis');
const axios = require('axios');
const http = require('http');

// 1. 给 Render 增加 HTTP 保活端口监听
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running fine!\n');
}).listen(PORT, () => {
    console.log(`🌐 保活 HTTP 服务已成功运行在端口 ${PORT}`);
});

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 600000 });
const TOKEN = process.env.BOT_TOKEN;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 2. 初始化云端 Redis（持久化存储用户）
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
}

// 记录用户 ID 至云端集合（Set 结构自动去重）
async function recordUser(userId) {
    if (!redis) return;
    try {
        await redis.sadd('bot_users', userId.toString());
    } catch (e) {
        console.error('云端写入用户失败:', e.message);
    }
}

// 获取累计用户总数
async function getUserCount() {
    if (!redis) return 0;
    try {
        return await redis.scard('bot_users');
    } catch (e) {
        console.error('读取用户数据失败:', e.message);
        return 0;
    }
}

bot.use(async (ctx, next) => {
    if (ctx.from && ctx.from.id) {
        recordUser(ctx.from.id);
    }
    return next();
});

// 查看累计用户统计（隐蔽管理员指令）
bot.command('stats', async (ctx) => {
    const totalCount = await getUserCount();
    ctx.reply(`📊 机器人运行数据统计\n\n👥 当前累计使用用户总数：${totalCount} 人\n⚡️ 当前并发槽位：${activeWorkers}/${MAX_CONCURRENT_TASKS}\n⏳ 队列等待数：${taskQueue.length}`);
});

// 3. 点击 /start 时响应说明
bot.start((ctx) => {
    const startMessage = 
`<b>👋 欢迎使用贴纸/表情包搬运机器人👋</b>

<b>🤖 贴纸/表情包搬运机器人使用说明：</b>

<b>📖 使用方法与格式：</b>

<b>1. 基础单包克隆 ✅</b>
<code>克隆#自定义表情包标题#需克隆表情包链接</code>
<i>例如：（克隆#免费搬运机器人 @stickers_porter_bot#https://t.me/addstickers/**）</i>

<b>2. 批量多包排队克隆（推荐）👍</b>
<code>克隆#
自定义表情包标题#需克隆表情包链接
自定义表情包标题#需克隆表情包链接
自定义表情包标题#需克隆表情包链接</code>
<i>例如：（克隆#
免费搬运机器人 @stickers_porter_bot#https://t.me/addstickers/**1
免费搬运机器人 @stickers_porter_bot#https://t.me/addstickers/**2
免费搬运机器人 @stickers_porter_bot#https://t.me/addstickers/**3
）</i>

<b>🔸 克隆：</b>命令前缀，触发克隆操作。
<b>🔸 自定义表情包标题：</b>您希望克隆后新贴纸包/表情包的名称。
<b>🔸 需克隆表情包链接：</b>原始贴纸/表情包的链接。

⚡️ <i>系统已升级多通道并发引擎，多包任务将并行极速处理！</i>`;

    ctx.reply(startMessage, { parse_mode: 'HTML' });
});

// 4. 并发工作池队列机制（支持多个表情包同时克隆）
const MAX_CONCURRENT_TASKS = 3; // 同时并发克隆的表情包数量（推荐 3~5，兼顾速度与不被 Telegram 限流）
const taskQueue = [];
let activeWorkers = 0;

function enqueueTask(task) {
    taskQueue.push(task);
    checkAndProcessNext();
}

function checkAndProcessNext() {
    // 只要有空闲的工作槽位，且队列中还有任务，就启动新的并发任务
    while (activeWorkers < MAX_CONCURRENT_TASKS && taskQueue.length > 0) {
        const nextTask = taskQueue.shift();
        activeWorkers++;
        
        processSingleClone(nextTask.ctx, nextTask.title, nextTask.packUrl)
            .catch(err => {
                console.error('任务执行异常:', err.message);
            })
            .finally(() => {
                activeWorkers--;
                checkAndProcessNext(); // 该任务完成，释放通道并处理下一个
            });
    }
}

// 单个贴纸包克隆的核心逻辑函数
async function processSingleClone(ctx, title, packUrl) {
    const match = packUrl.match(/(?:addstickers|addemoji)\/([a-zA-Z0-9_]+)/);
    if (!match) {
        return ctx.reply(`❌ 无法识别贴纸链接：${packUrl}`);
    }

    const originPackName = match[1];

    const progressMsg = await ctx.reply(
        `⏳ 正在克隆表情包：\n` +
        `📌 标题：【${title}】\n` +
        `🔢 克隆进度：【正在获取表情包信息...】`
    );

    try {
        const originPack = await ctx.telegram.getStickerSet(originPackName);
        const totalCount = originPack.stickers.length;

        const botInfo = await ctx.telegram.getMe();
        const randomStr = Math.random().toString(36).substring(2, 10);
        const newPackName = 'pack_' + randomStr + '_by_' + botInfo.username;
        const userId = ctx.from.id;

        const firstItem = originPack.stickers[0];
        const firstFormat = firstItem.is_animated ? 'animated' : (firstItem.is_video ? 'video' : 'static');
        
        const firstStickerObj = {
            sticker: firstItem.file_id,
            format: firstFormat,
            emoji_list: [firstItem.emoji || '👍']
        };

        const createUrl = `https://api.telegram.org/bot${TOKEN}/createNewStickerSet`;
        const createRes = await axios.post(createUrl, {
            user_id: userId,
            name: newPackName,
            title: title,
            stickers: [firstStickerObj],
            sticker_type: originPack.sticker_type === 'custom_emoji' ? 'custom_emoji' : 'regular'
        });

        if (!createRes.data.ok) {
            throw new Error(createRes.data.description || '创建贴纸包失败');
        }

        await ctx.telegram.editMessageText(
            ctx.chat.id,
            progressMsg.message_id,
            null,
            `⏳ 正在克隆表情包：\n` +
            `📌 标题：【${title}】\n` +
            `🔢 克隆进度：【已添加第 1/${totalCount} 个贴纸】`
        );

        const addUrl = `https://api.telegram.org/bot${TOKEN}/addStickerToSet`;
        let lastUpdate = Date.now();

        for (let i = 1; i < totalCount; i++) {
            const item = originPack.stickers[i];
            const itemFormat = item.is_animated ? 'animated' : (item.is_video ? 'video' : 'static');
            
            const stickerObj = {
                sticker: item.file_id,
                format: itemFormat,
                emoji_list: [item.emoji || '👍']
            };

            try {
                await axios.post(addUrl, {
                    user_id: userId,
                    name: newPackName,
                    sticker: stickerObj
                });
            } catch (addErr) {
                console.error(`追加贴纸 ${i} 失败:`, addErr.response?.data?.description || addErr.message);
            }

            const currentCount = i + 1;
            // 控制刷新频率，降低 Telegram API 负载
            if (currentCount % 5 === 0 || currentCount === totalCount || Date.now() - lastUpdate > 2000) {
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        progressMsg.message_id,
                        null,
                        `⏳ 正在克隆表情包：\n` +
                        `📌 标题：【${title}】\n` +
                        `🔢 克隆进度：【已添加第 ${currentCount}/${totalCount} 个贴纸】`
                    );
                    lastUpdate = Date.now();
                } catch (e) {}
            }

            await sleep(150); // 微延迟防止并发多任务时触发 Telegram 429 限流
        }

        const finalLink = 'https://t.me/addstickers/' + newPackName;
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            progressMsg.message_id,
            null,
            `✅ 表情包克隆完成！\n\n` +
            `📌 标题：【${title}】\n` +
            `🔢 总计：共 ${totalCount} 个贴纸\n` +
            `🔗 链接：\n${finalLink}`
        );

    } catch (err) {
        console.error('克隆失败:', err.response?.data || err.message);
        const errMsg = err.response?.data?.description || err.message || '未知错误';
        try {
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                progressMsg.message_id,
                null,
                `❌ 克隆失败：${errMsg}`
            );
        } catch (e) {
            ctx.reply(`❌ 克隆失败：${errMsg}`);
        }
    }
}

// 5. 监听文本消息解析任务入队
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();

    if (text.startsWith('/start')) return;

    const lines = text.split('\n');
    const tasksFound = [];

    for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        if (line.startsWith('克隆#')) {
            line = line.replace('克隆#', '');
        }

        const parts = line.split('#');
        if (parts.length >= 2) {
            const title = parts[0].trim();
            const url = parts[1].trim();
            if (title && url && (url.includes('addstickers') || url.includes('addemoji'))) {
                tasksFound.push({ title, url });
            }
        }
    }

    if (tasksFound.length === 0) return;

    for (let i = 0; i < tasksFound.length; i++) {
        const item = tasksFound[i];
        
        // 如果当前工作通道已满，提示排队
        if (activeWorkers >= MAX_CONCURRENT_TASKS) {
            const queuePos = taskQueue.length + 1;
            ctx.reply(
                `✅ 已收到请求\n\n` +
                `📌 新标题：【${item.title}】\n` +
                `⌛️ 状态：【已有 ${MAX_CONCURRENT_TASKS} 个任务正在全力处理，当前已放入队列（排在第 ${queuePos} 位）...】`
            );
        }

        enqueueTask({
            ctx: ctx,
            title: item.title,
            packUrl: item.url
        });
    }
});

bot.launch().then(() => {
    console.log('🤖 贴纸并发机器人已成功上线开机！');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
