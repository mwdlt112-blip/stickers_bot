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

// 查看累计用户统计
bot.command('stats', async (ctx) => {
    const users = getUsers();
    ctx.reply(`📊 机器人运行数据统计\n\n👥 当前累计使用用户总数：${users.size} 人`);
});

// 单个贴纸包克隆的核心逻辑函数
async function processSingleClone(ctx, title, packUrl, taskIndex = 1, totalTasks = 1) {
    const match = packUrl.match(/(?:addstickers|addemoji)\/([a-zA-Z0-9_]+)/);
    if (!match) {
        return ctx.reply(`❌ 任务 [${taskIndex}/${totalTasks}] 无法识别贴纸链接：${packUrl}`);
    }

    const originPackName = match[1];
    const prefix = totalTasks > 1 ? `[任务 ${taskIndex}/${totalTasks}] ` : '';

    // 初始化进度面板
    const progressMsg = await ctx.reply(
        `⏳ ${prefix}正在准备克隆表情包...\n` +
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

        // 更新进度：已添加第 1 个
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            progressMsg.message_id,
            null,
            `⏳ ${prefix}正在克隆表情包：\n` +
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
            // 控制刷新频率（每 5 个贴纸或间隔 1.5 秒更新一次进度，防止 API 限流）
            if (currentCount % 5 === 0 || currentCount === totalCount || Date.now() - lastUpdate > 1500) {
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        progressMsg.message_id,
                        null,
                        `⏳ ${prefix}正在克隆表情包：\n` +
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
            `✅ ${prefix}表情包克隆完成！\n\n` +
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
                `❌ ${prefix}克隆失败：${errMsg}`
            );
        } catch (e) {
            ctx.reply(`❌ ${prefix}克隆失败：${errMsg}`);
        }
    }
}

// 监听消息并支持批量解析
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();

    const lines = text.split('\n');
    const tasks = [];

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
                tasks.push({ title, url });
            }
        }
    }

    if (tasks.length === 0) return;

    if (tasks.length > 1) {
        await ctx.reply(`🚀 已收到 ${tasks.length} 个表情包克隆任务，正在依次处理...`);
    }

    for (let i = 0; i < tasks.length; i++) {
        await processSingleClone(ctx, tasks[i].title, tasks[i].url, i + 1, tasks.length);
        await sleep(1000);
    }
});

bot.launch().then(() => {
    console.log('🤖 机器人已成功上线开机！');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
