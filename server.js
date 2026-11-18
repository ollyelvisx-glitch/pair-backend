const express = require('express');
const cors = require('cors');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!API_KEY) {
    throw new Error('Set API_KEY in your hosting environment.');
}

const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const logger = pino({ level: 'silent' });
const sessions = new Map();

function validId(id) {
    return /^[a-zA-Z0-9_-]{1,40}$/.test(id);
}

function authenticate(req, res, next) {
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }

    next();
}

app.use('/sessions', authenticate);

function getSession(id) {
    return sessions.get(id);
}

async function startWhatsAppBot(userId) {
    if (!validId(userId)) {
        throw new Error('Invalid user ID');
    }

    const old = sessions.get(userId);

    if (old?.starting || old?.sock) return old;

    const session = {
        sock: null,
        qr: null,
        connected: false,
        starting: true,
        reconnectTimer: null,
        stopped: false
    };

    sessions.set(userId, session);

    try {
        const authFolder = path.join(SESSION_DIR, userId);

        fs.mkdirSync(authFolder, { recursive: true });

        const { state, saveCreds } =
            await useMultiFileAuthState(authFolder);

        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger,
            auth: state,
            printQRInTerminal: false,
            browser: ['OLLY MD', 'Chrome', '2.0.0'],
            syncFullHistory: false
        });

        session.sock = sock;
        session.starting = false;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {

            if (qr) {
                session.qr = qr;
                console.log(`[${userId}] QR generated`);
            }

            if (connection === 'open') {
                session.connected = true;
                session.qr = null;
                console.log(`[${userId}] Connected`);
            }

            if (connection === 'close') {
                session.connected = false;
                session.sock = null;

                const code = lastDisconnect?.error?.output?.statusCode;

                if (
                    code === DisconnectReason.loggedOut ||
                    session.stopped
                ) {
                    session.qr = null;
                    return;
                }

                if (!session.reconnectTimer) {
                    session.reconnectTimer = setTimeout(() => {
                        session.reconnectTimer = null;

                        startWhatsAppBot(userId).catch(console.error);
                    }, 5000);
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const m of messages) {
                if (!m.message || m.key.fromMe) continue;

                const sender = m.key.remoteJid;

                if (!sender || sender === 'status@broadcast') continue;

                const text =
                    m.message.conversation ||
                    m.message.extendedTextMessage?.text ||
                    '';

                if (!text.startsWith('.')) continue;

                const command = text.trim().split(/\s+/)[0].slice(1).toLowerCase();

                try {
                    if (command === 'ping') {
                        await sock.sendMessage(sender, {
                            text: '🏓 Pong! OLLY MD is online.'
                        }, { quoted: m });
                    }

                    else if (command === 'alive') {
                        await sock.sendMessage(sender, {
                            text: '🟢 OLLY MD is alive!'
                        }, { quoted: m });
                    }

                    else if (command === 'menu' || command === 'help') {
                        await sock.sendMessage(sender, {
                            text:
                                '╭━━━〔 OLLY MD 〕━━━╮\n\n' +
                                '🏓 .ping - Check bot\n' +
                                '🟢 .alive - Bot status\n' +
                                '📥 .download - Save eligible quoted media\n' +
                                '⚙️ .settings - Settings\n' +
                                '📋 .menu - Commands\n\n' +
                                '╰━━━━━━━━━━━━━━━━╯'
                        }, { quoted: m });
                    }

                    else if (command === 'settings') {
                        await sock.sendMessage(sender, {
                            text:
                                '⚙️ OLLY MD SETTINGS\n\n' +
                                `Connection: ${session.connected ? 'Online 🟢' : 'Offline 🔴'}\n` +
                                'Version: 2.0.0\n' +
                                'Multi-user: Enabled'
                        }, { quoted: m });
                    }

                    else if (command === 'download') {
                        const context = m.message.extendedTextMessage?.contextInfo;
                        const quoted = context?.quotedMessage;

                        if (!quoted) {
                            await sock.sendMessage(sender, {
                                text: 'Reply to a normal photo, video, audio or document with .download.'
                            }, { quoted: m });
                            continue;
                        }

                        const mediaMessage =
                            quoted.imageMessage ||
                            quoted.videoMessage ||
                            quoted.audioMessage ||
                            quoted.documentMessage;

                        if (!mediaMessage) {
                            await sock.sendMessage(sender, {
                                text: 'Unsupported media. Send a normal photo, video, audio or document.'
                            }, { quoted: m });
                            continue;
                        }

                        try {
                            const quotedKey = {
                                remoteJid: sender,
                                id: context.stanzaId,
                                participant: context.participant
                            };

                            const quotedMsg = {
                                key: quotedKey,
                                message: quoted
                            };

                            const buffer = await downloadMediaMessage(
                                quotedMsg,
                                'buffer',
                                {},
                                {
                                    logger,
                                    reuploadRequest: sock.updateMediaMessage
                                }
                            );

                            if (!buffer || !buffer.length) {
                                throw new Error('Empty media buffer');
                            }

                            const userFolder = path.join(DOWNLOAD_DIR, userId);

                            fs.mkdirSync(userFolder, { recursive: true });

                            const extension =
                                mediaMessage.mimetype?.split('/')[1]?.split(';')[0] || 'bin';

                            const safeExtension = extension.replace(/[^a-zA-Z0-9]/g, '');

                            const filename =
                                `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${safeExtension}`;

                            const filePath = path.join(userFolder, filename);

                            fs.writeFileSync(filePath, buffer);

                            const mediaType = mediaMessage.imageMessage
                                ? 'image'
                                : mediaMessage.videoMessage
                                    ? 'video'
                                    : mediaMessage.audioMessage
                                        ? 'audio'
                                        : 'document';

                            await sock.sendMessage(sender, {
                                text: `✅ ${mediaType.toUpperCase()} saved successfully.\nFile: ${filename}`
                            }, { quoted: m });

                        } catch (error) {
                            console.error(`[${userId}] Download error:`, error);

                            await sock.sendMessage(sender, {
                                text: '❌ Download failed. Check the media format and server logs.'
                            }, { quoted: m });
                        }
                    }

                } catch (error) {
                    console.error(`[${userId}] Command error:`, error);
                }
            }
        });

        return session;

    } catch (error) {
        session.starting = false;
        session.sock = null;

        throw error;
    }
}

// Start a user's WhatsApp session
app.post('/sessions/:userId/start', async (req, res) => {
    try {
        const session = await startWhatsAppBot(req.params.userId);

        res.json({
            success: true,
            connected: session.connected,
            message: 'Session initialized'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get user's QR
app.get('/sessions/:userId/qr', async (req, res) => {
    const session = getSession(req.params.userId);

    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'Start the session first.'
        });
    }

    if (session.connected) {
        return res.json({
            success: true,
            connected: true
        });
    }

    if (!session.qr) {
        return res.json({
            success: false,
            message: 'QR not ready yet.'
        });
    }

    try {
        const qrImage = await QRCode.toDataURL(session.qr);

        res.json({
            success: true,
            connected: false,
            qrImage
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'QR generation failed'
        });
    }
});

// Check session status
app.get('/sessions/:userId/status', (req, res) => {
    const session = getSession(req.params.userId);

    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'Session not found'
        });
    }

    res.json({
        success: true,
        connected: session.connected
    });
});

// Disconnect session
app.delete('/sessions/:userId', async (req, res) => {
    const userId = req.params.userId;
    const session = getSession(userId);

    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'Session not found'
        });
    }

    session.stopped = true;

    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
    }

    sessions.delete(userId);

    try {
        await session.sock?.logout();
    } catch (error) {
        console.error('Logout error:', error.message);
    }

    res.json({
        success: true,
        message: 'WhatsApp disconnected'
    });
});

app.get('/ping', (req, res) => {
    res.json({
        status: 'online',
        bot: 'OLLY MD',
        version: '2.0.0',
        activeSessions: sessions.size,
        time: Date.now()
    });
});

app.listen(PORT, () => {
    console.log(`🚀 OLLY MD running on port ${PORT}`);
    console.log(`Storage: ${DATA_DIR}`);
});
