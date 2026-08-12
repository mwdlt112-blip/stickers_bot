require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http');
const fs = require('fs');
const path = require('path');

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

// 2. 用户数据持久化文件路径
const USERS_FILE = path.join(__dirname, 'users.json');

function getUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            return new Set(JSON.parse(data));
        }
    } catch (e) {
        console.error('读取用户数据失败:', e.message);
    }
    return new Set();
}

function recordUser(userId) {
    const users = getUsers();
    if (!users.has(userId)) {
        users.add(userId);
        try {
            fs.writeFileSync(USERS_FILE, JSON.stringify(Array.from(users)));
        } catch (e) {
            console.error('保存用户数据失败:', e.message);
        }
    }
}

bot.use((ctx, next) => {
    if (ctx.from && ctx.from.id) {
        recordUser(ctx.from.id);
    }
    return next();
});

// 查看累计用户统计（隐蔽管理员指令）
bot.command('stats', async (ctx) => {
    const users = getUsers();
    ctx.reply(`📊 机器人运行数据统计\n\n👥 当前累计使用用户总数：${users.size} 人`);
});

// 3. 点击 /start 时响应包含指定粗体与斜体文本
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

⚠️ <i>请确保信息填写正确，以便程序顺利完成克隆。</i>`;

    ctx.reply(startMessage, { parse_mode: 'HTML' });
});

// 4. 任务队列机制
const taskQueue = [];
let isProcessingQueue = false;

function enqueueTask(task) {
    taskQueue.push(task);
    processQueue();
}

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (taskQueue.length > 0) {
        const task = taskQueue.shift();
        try {
            await processSingleClone(task.ctx, task.title, task.packUrl);
        } catch (err) {
            console.error('处理队列任务发生异常:', err.message);
        }
        await sleep(1000);
    }

    isProcessingQueue = false;
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
            if (currentCount % 5 === 0 || currentCount === totalCount || Date.now() - lastUpdate > 1500) {
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

            await sleep(100);
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
        
        if (isProcessingQueue || taskQueue.length > 0) {
            const queuePos = taskQueue.length + (isProcessingQueue ? 1 : 0);
            ctx.reply(
                `✅ 已收到请求\n\n` +
                `📌新标题：【${item.title}】\n` +
                `⌛️状态：【当前已有任务在处理，已为你放入队列（排队第 ${queuePos} 位）...】`
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
    console.log('🤖 机器人已成功上线开机！');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
