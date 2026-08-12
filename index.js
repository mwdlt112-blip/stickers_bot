require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http');

// 给 Render 增加端口保活监听，防止被当作服务挂掉
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running fine!\n');
}).listen(PORT, () => {
    console.log(`🌐 保活 HTTP 服务已成功运行在端口 ${PORT}`);
});

const bot = new Telegraf(process.env.BOT_TOKEN, {
    handlerTimeout: 600000
});
const TOKEN = process.env.BOT_TOKEN;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();

    if (text.startsWith('克隆#')) {
        const parts = text.split('#');
        if (parts.length < 3) {
            return ctx.reply('❌ 格式不正确！正确格式为：\n克隆#自定义标题#贴纸链接');
        }

        const title = parts[1];
        const packUrl = parts[2];

        const match = packUrl.match(/(?:addstickers|addemoji)\/([a-zA-Z0-9_]+)/);
        if (!match) {
            return ctx.reply('❌ 无法识别的贴纸链接，请检查格式！');
        }

        const originPackName = match[1];

        const progressMsg = await ctx.reply(
            '⏳ 已收到请求，正在准备处理...\n' +
            '📌 新标题：' + title + '\n' +
            '📦 原包短名：' + originPackName
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
                `⏳ 正在克隆贴纸包：【${title}】\n` +
                `📊 克隆进度：已添加 1 / ${totalCount} 个贴纸...`
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
                    console.error('追加贴纸 ' + i + ' 失败:', addErr.response?.data?.description || addErr.message);
                }

                const currentCount = i + 1;
                if (currentCount % 5 === 0 || currentCount === totalCount || Date.now() - lastUpdate > 1500) {
                    try {
                        await ctx.telegram.editMessageText(
                            ctx.chat.id,
                            progressMsg.message_id,
                            null,
                            `⏳ 正在克隆贴纸包：【${title}】\n` +
                            `📊 克隆进度：(${totalCount} 个贴纸中已添加 ${currentCount} 个)`
                        );
                        lastUpdate = Date.now();
                    } catch (e) {
                    }
                }

                await sleep(100);
            }

            const finalLink = 'https://t.me/addstickers/' + newPackName;
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                progressMsg.message_id,
                null,
                '✅ **贴纸包克隆完成！**\n\n' +
                '📖 标题：' + title + '\n' +
                '🔢 总计：' + totalCount + ' 个贴纸\n' +
                '🔗 链接：\n' + finalLink,
                { parse_mode: 'Markdown' }
            );

        } catch (err) {
            console.error('克隆贴纸包失败:', err.response?.data || err.message);
            const errMsg = err.response?.data?.description || err.message || '未知错误';
            try {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    progressMsg.message_id,
                    null,
                    '❌ 克隆失败：' + errMsg
                );
            } catch (e) {
                ctx.reply('❌ 克隆失败：' + errMsg);
            }
        }
    }
});

bot.launch().then(() => {
    console.log('🤖 机器人已成功上线开机！');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
