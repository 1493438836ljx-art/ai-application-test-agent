const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 导入安全工具
const { isValidSessionId, validatePath, SafeZipExtractor, cleanupExpiredFiles, buildClaudeArgs } = require('./utils/security');

const app = express();
const PORT = process.env.PORT || 3000;

// 生成 UUID v4
function generateUUID() {
    return crypto.randomUUID();
}

// 内容去重：存储已发送内容的哈希值（每个请求独立）
const contentDedupMap = new Map(); // sessionId -> Set<contentHash>

/**
 * 获取或创建会话的去重集合
 */
function getDedupSet(sessionId) {
    if (!contentDedupMap.has(sessionId)) {
        contentDedupMap.set(sessionId, new Set());
    }
    return contentDedupMap.get(sessionId);
}

/**
 * 清理会话的去重集合
 */
function clearDedupSet(sessionId) {
    contentDedupMap.delete(sessionId);
}

/**
 * 检查内容是否已发送过（去重）
 * @param {string} sessionId - 会话ID
 * @param {string} content - 内容
 * @param {number} minLen - 最小去重长度（短于这个长度的内容不去重）
 * @returns {boolean} - true 表示是重复内容，应跳过
 */
function isDuplicateContent(sessionId, content, minLen = 20) {
    if (!content || content.length < minLen) {
        return false; // 短内容不去重
    }
    const dedupSet = getDedupSet(sessionId);
    // 标准化内容：去除多余空白、统一换行符
    const normalizedContent = content.trim().replace(/\s+/g, ' ');
    const contentHash = crypto.createHash('md5').update(normalizedContent).digest('hex');

    if (dedupSet.has(contentHash)) {
        return true; // 重复内容
    }
    dedupSet.add(contentHash);
    return false;
}

/**
 * 清理隔离的临时工作目录
 * @param {string} workDir - 工作目录路径
 * @param {string} sessionId - 会话ID
 */
function cleanupTempWorkDir(workDir, sessionId) {
    try {
        if (workDir && fs.existsSync(workDir)) {
            fs.rmSync(workDir, { recursive: true, force: true });
            console.log(`[${formatTimestamp()}] [ISOLATE] 清理隔离工作目录: ${workDir}`);
        }
        // 同时清理去重集合
        clearDedupSet(sessionId);
    } catch (e) {
        console.error(`[${formatTimestamp()}] [ISOLATE ERROR] 清理失败: ${e.message}`);
    }
}

/**
 * 清理旧的隔离会话目录（保留最近 1 小时的）
 */
function cleanupOldSessionDirs() {
    const sessionsBaseDir = path.join('uploads', 'sessions');
    if (!fs.existsSync(sessionsBaseDir)) {
        return;
    }

    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 小时

    try {
        const entries = fs.readdirSync(sessionsBaseDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('session-')) {
                const dirPath = path.join(sessionsBaseDir, entry.name);
                const stat = fs.statSync(dirPath);
                if (now - stat.mtimeMs > maxAge) {
                    fs.rmSync(dirPath, { recursive: true, force: true });
                    console.log(`[${formatTimestamp()}] [CLEANUP] 清理过期隔离目录: ${entry.name}`);
                }
            }
        }
    } catch (e) {
        console.error(`[${formatTimestamp()}] [CLEANUP ERROR] 清理过期目录失败: ${e.message}`);
    }
}

// 配置文件上传
const upload = multer({
    dest: 'uploads/',
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const uploadDir = 'uploads';
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, uniqueSuffix + path.extname(file.originalname));
        }
    })
});

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 启动时清理过期文件
cleanupExpiredFiles('./uploads/skills', 60 * 60 * 1000);  // 清理 1 小时前的 skill 文件
cleanupOldSessionDirs();  // 清理过期的隔离会话目录

// 定期清理（每 10 分钟）
setInterval(() => {
    cleanupOldSessionDirs();
}, 10 * 60 * 1000);

/**
 * 健康检查
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        securityEnabled: true
    });
});

/**
 * 格式化时间戳
 */
function formatTimestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * 通用 SSE 辅助函数
 */
function setupSSE(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
}

/**
 * 发送 SSE 事件
 * 注意：将 eventType 也放入 data 中，以便 Java 后端能够正确解析 type 字段
 */
function sendEvent(res, eventType, data) {
    // 确保 data 中包含 type 字段
    const dataWithType = {
        type: eventType,
        ...data
    };
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(dataWithType)}\n\n`);
}

/**
 * 从 stream-json 格式中提取内容
 * 只提取纯文本内容，过滤思考过程和工具调用
 */
function extractContent(parsed) {
    // assistant 类型 - Claude 的响应消息
    if (parsed.type === 'assistant') {
        // Claude CLI stream-json 格式中，内容在 message 对象里
        // 结构: { type: "assistant", message: { content: [...], role: "assistant", ... }, ... }
        if (parsed.message && typeof parsed.message === 'object') {
            const msg = parsed.message;
            // message.content 通常是数组
            if (Array.isArray(msg.content)) {
                const textContent = [];
                for (const item of msg.content) {
                    // 只提取 text 类型，过滤 thinking 和 tool_use
                    if (item.type === 'text' && item.text) {
                        textContent.push(item.text);
                    }
                }
                if (textContent.length > 0) {
                    return { content: textContent.join('\n'), contentType: 'assistant' };
                }
            }
            // 如果 message.content 是字符串
            if (typeof msg.content === 'string') {
                return { content: msg.content, contentType: 'assistant' };
            }
        }

        // 兼容旧格式：直接在 parsed.content 中
        if (parsed.content) {
            if (Array.isArray(parsed.content)) {
                const textContent = [];
                for (const item of parsed.content) {
                    // 只提取 text 类型
                    if (item.type === 'text' && item.text) {
                        textContent.push(item.text);
                    }
                }
                if (textContent.length > 0) {
                    return { content: textContent.join('\n'), contentType: 'assistant' };
                }
            } else if (typeof parsed.content === 'string') {
                return { content: parsed.content, contentType: 'assistant' };
            }
        }

        // 没有可提取的内容
        return { content: '', contentType: 'assistant' };
    }

    // user 类型 - 用户消息（通常是工具结果）
    // 过滤掉工具结果，只保留纯文本
    if (parsed.type === 'user') {
        // 检查是否内容在 message 对象中
        if (parsed.message && typeof parsed.message === 'object') {
            const msg = parsed.message;
            if (msg.content && Array.isArray(msg.content)) {
                const textContent = [];
                for (const item of msg.content) {
                    // 只提取字符串类型的文本，跳过 tool_result
                    if (typeof item === 'string') {
                        textContent.push(item);
                    } else if (item.type === 'text' && item.text) {
                        textContent.push(item.text);
                    }
                }
                if (textContent.length > 0) {
                    return { content: textContent.join('\n'), contentType: 'user' };
                }
            } else if (typeof msg.content === 'string') {
                return { content: msg.content, contentType: 'user' };
            }
        }

        // 兼容旧格式
        if (parsed.content) {
            if (typeof parsed.content === 'string') {
                return { content: parsed.content, contentType: 'user' };
            } else if (Array.isArray(parsed.content)) {
                const textContent = [];
                for (const item of parsed.content) {
                    if (typeof item === 'string') {
                        textContent.push(item);
                    } else if (item.text) {
                        textContent.push(item.text);
                    }
                }
                if (textContent.length > 0) {
                    return { content: textContent.join('\n'), contentType: 'user' };
                }
            }
        }

        // user 类型没有可提取的纯文本内容
        return { content: '', contentType: 'user' };
    }

    // message 类型 - Claude API 的主要消息格式
    if (parsed.type === 'message' && Array.isArray(parsed.content)) {
        const textContent = [];
        for (const item of parsed.content) {
            // 只提取 text 类型
            if (item.type === 'text' && item.text) {
                textContent.push(item.text);
            }
        }
        if (textContent.length > 0) {
            return { content: textContent.join('\n'), contentType: 'message' };
        }
        return { content: '', contentType: 'message' };
    }

    // tool_use 类型 - 不发送给前端
    if (parsed.type === 'tool_use') {
        return { content: '', contentType: 'tool_use' };
    }

    // result 类型 - 这是最终结果，需要发送
    if (parsed.type === 'result') {
        let content = '';
        if (parsed.content) {
            content = typeof parsed.content === 'string'
                ? parsed.content
                : JSON.stringify(parsed.content, null, 2);
        } else if (parsed.result) {
            content = typeof parsed.result === 'string'
                ? parsed.result
                : JSON.stringify(parsed.result, null, 2);
        }
        return { content: content, contentType: 'result' };
    }

    // text 类型 - 发送纯文本
    if (parsed.type === 'text' || parsed.subtype === 'text') {
        return {
            content: parsed.text || (typeof parsed.content === 'string' ? parsed.content : '') || '',
            contentType: 'text'
        };
    }

    // thinking 类型 - 不发送给前端
    if (parsed.type === 'thinking' || parsed.subtype === 'thinking') {
        return { content: '', contentType: 'thinking' };
    }

    // 默认 - 确保返回字符串
    let defaultContent = '';
    if (typeof parsed.content === 'string') {
        defaultContent = parsed.content;
    } else if (typeof parsed.text === 'string') {
        defaultContent = parsed.text;
    } else if (typeof parsed.message === 'string') {
        defaultContent = parsed.message;
    } else if (parsed.content) {
        defaultContent = JSON.stringify(parsed.content);
    }

    return {
        content: defaultContent,
        contentType: parsed.type || 'text'
    };
}

/**
 * 流式任务执行接口 (SSE)
 * 支持的入参：
 * 1. taskContent: 任务内容（String，必填）
 * 2. config: 配置信息（JSON，非必填）
 * 3. skillFile: Skill文件（zip文件，非必填）
 * 4. sessionId: 会话ID（String，非必填）- 用于多轮对话会话持久化
 */
app.post('/api/task/stream', upload.single('skillFile'), async (req, res) => {
    const requestStartTime = Date.now();
    const requestTimestamp = formatTimestamp();
    const { config, sessionId: inputSessionId } = req.body;
    let taskContent = req.body.taskContent;
    const skillFile = req.file;

    // 验证必填参数
    if (!taskContent) {
        console.log(`[${requestTimestamp}] [REQUEST] 任务执行失败: 缺少 taskContent 参数`);
        return res.status(400).json({ error: 'taskContent参数是必需的' });
    }

    // 验证 sessionId 格式（如果提供了）
    if (inputSessionId && !isValidSessionId(inputSessionId)) {
        console.log(`[${requestTimestamp}] [REQUEST] 无效的 sessionId 格式: ${inputSessionId}`);
        return res.status(400).json({
            error: '无效的sessionId格式，只接受UUID格式',
            code: 'INVALID_SESSION_ID'
        });
    }

    // 记录请求开始日志
    console.log('─'.repeat(60));
    console.log(`[${requestTimestamp}] [REQUEST] 收到任务执行请求`);
    console.log(`  - 任务内容摘要: ${taskContent.substring(0, 100)}${taskContent.length > 100 ? '...' : ''}`);
    console.log(`  - 传入会话ID: ${inputSessionId || '(无，将创建新会话)'}`);
    console.log(`  - 配置信息: ${config ? '有' : '无'}`);
    console.log(`  - Skill文件: ${skillFile ? skillFile.originalname : '无'}`);

    try {
        // 准备会话ID
        let effectiveSessionId = inputSessionId;
        let isNewSession = !effectiveSessionId;

        if (isNewSession) {
            effectiveSessionId = generateUUID();
            console.log(`[${formatTimestamp()}] [SESSION] 创建新会话ID: ${effectiveSessionId}`);
        } else {
            console.log(`[${formatTimestamp()}] [SESSION] 恢复会话ID: ${effectiveSessionId}`);
        }

        // 设置 SSE
        setupSSE(req, res);

        // 发送开始事件
        sendEvent(res, 'start', { sessionId: effectiveSessionId });

        // 处理配置信息
        if (config) {
            try {
                const configObj = typeof config === 'string' ? JSON.parse(config) : config;
                Object.keys(configObj).forEach(key => {
                    taskContent += `\n\n配置 ${key}: ${JSON.stringify(configObj[key])}`;
                });
                console.log(`[${formatTimestamp()}] [CONFIG] 配置信息已解析，共 ${Object.keys(configObj).length} 项`);
            } catch (e) {
                console.error(`[${formatTimestamp()}] [ERROR] 配置解析失败: ${e.message}`);
            }
        }

        // ========================================
        // 方案 A：使用隔离的临时工作目录
        // ========================================

        // 创建临时工作目录（用于隔离每次请求）
        const tempWorkDir = path.join('uploads', 'sessions', 'session-' + effectiveSessionId);
        if (!fs.existsSync(tempWorkDir)) {
            fs.mkdirSync(tempWorkDir, { recursive: true });
            console.log(`[${formatTimestamp()}] [ISOLATE] 创建隔离工作目录: ${tempWorkDir}`);
        }

        // 安全处理 Skill 文件
        let skillDir = null;
        if (skillFile) {
            try {
                // 将 Skill 解压到隔离工作目录中的 skill 子目录
                const extractDir = path.join(tempWorkDir, 'skill');
                const extractor = new SafeZipExtractor(extractDir);

                const result = extractor.extract(skillFile.path);
                skillDir = result.targetDir;
                console.log(`[${formatTimestamp()}] [SKILL] Skill文件安全解压至隔离目录: ${extractDir}`);
                console.log(`[${formatTimestamp()}] [SKILL] 解压文件: ${result.files.join(', ')}`);

            } catch (extractError) {
                console.error(`[${formatTimestamp()}] [SKILL ERROR] 解压失败: ${extractError.message}`);
                sendEvent(res, 'error', {
                    message: 'Skill文件安全验证失败: ' + extractError.message,
                    code: 'SKILL_SECURITY_ERROR'
                });
                res.end();
                // 清理隔离目录
                cleanupTempWorkDir(tempWorkDir, effectiveSessionId);
                return;
            } finally {
                // 清理上传的临时文件
                if (fs.existsSync(skillFile.path)) {
                    fs.unlinkSync(skillFile.path);
                }
            }
        }

        // 清理旧的隔离工作目录（保留最近 1 小时的）
        cleanupOldSessionDirs();

        // 使用安全的方式构建 Claude CLI 参数
        let claudeArgs;
        try {
            claudeArgs = buildClaudeArgs({
                sessionId: effectiveSessionId,
                resume: !isNewSession,
                verbose: true,
                skillDir: skillDir,
                outputFormat: 'stream-json',
                dangerouslySkipPermissions: true  // 注意：生产环境应移除此选项
            });
        } catch (argError) {
            console.error(`[${formatTimestamp()}] [ERROR] 参数构建失败: ${argError.message}`);
            sendEvent(res, 'error', {
                message: argError.message,
                code: 'ARGUMENT_ERROR'
            });
            res.end();
            // 清理隔离目录
            cleanupTempWorkDir(tempWorkDir, effectiveSessionId);
            return;
        }

        console.log(`[${formatTimestamp()}] [EXECUTE] 执行命令: ${claudeArgs[0]} ${claudeArgs.slice(1, 5).join(' ')}...`);
        console.log(`[${formatTimestamp()}] [ISOLATE] 使用隔离工作目录: ${tempWorkDir}`);

        // 在 Windows 上需要使用 shell 来执行 .cmd 文件
        // 使用 shell: true 是安全的，因为参数已经通过数组传递（不是字符串拼接）
        const isWindows = process.platform === 'win32';
        const claudeProcess = spawn(claudeArgs[0], claudeArgs.slice(1), {
            cwd: tempWorkDir,  // 使用隔离工作目录，而非项目根目录
            env: process.env,
            shell: isWindows  // Windows 上需要 shell 来执行 .cmd/.bat 文件
        });

        let closed = false;
        const timeoutId = setTimeout(() => {
            if (!closed) {
                console.log(`[${formatTimestamp()}] [TIMEOUT] 任务执行超时`);
                claudeProcess.kill();
            }
        }, 600000); // 10分钟超时

        // 处理 stdout
        claudeProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            console.log(`[${formatTimestamp()}] [STDOUT] 收到数据长度: ${chunk.length}`);
            const lines = chunk.split('\n').filter(line => line.trim());
            console.log(`[${formatTimestamp()}] [STDOUT] 解析出 ${lines.length} 行`);

            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    console.log(`[${formatTimestamp()}] [STDOUT] 解析类型: ${parsed.type}`);

                    // 跳过 system 类型的消息
                    if (parsed.type === 'system') {
                        continue;
                    }

                    const extracted = extractContent(parsed);
                    console.log(`[${formatTimestamp()}] [STDOUT] 提取内容类型: ${extracted?.contentType}, 内容长度: ${extracted?.content?.length || 0}`);
                    if (extracted && extracted.content) {
                        // 内容去重检查（最小长度 50 字符）
                        if (isDuplicateContent(effectiveSessionId, extracted.content, 20)) {
                            console.log(`[${formatTimestamp()}] [DEDUP] 跳过重复内容: ${extracted.contentType}, 长度=${extracted.content.length}`);
                        } else {
                            sendEvent(res, 'chunk', {
                                content: extracted.content,
                                contentType: extracted.contentType,
                                toolName: extracted.toolName || '',
                                toolInput: extracted.toolInput || ''
                            });
                        }
                    }
                } catch (e) {
                    if (line.trim()) {
                        sendEvent(res, 'chunk', { content: line });
                    }
                }
            }
        });

        // 处理 stderr
        claudeProcess.stderr.on('data', (data) => {
            const chunk = data.toString();
            console.error(`[${formatTimestamp()}] [STDERR] ${chunk}`);
        });

        // 进程结束
        claudeProcess.on('close', (code) => {
            if (closed) return;
            closed = true;
            clearTimeout(timeoutId);

            const duration = Date.now() - requestStartTime;
            console.log(`[${formatTimestamp()}] [DONE] 任务执行完成, 耗时: ${duration}ms, 退出码: ${code}`);

            // 清理去重集合和隔离工作目录
            cleanupTempWorkDir(tempWorkDir, effectiveSessionId);

            if (code === 0) {
                sendEvent(res, 'done', {
                    sessionId: effectiveSessionId,
                    duration
                });
            } else {
                sendEvent(res, 'error', {
                    message: `任务执行失败，退出码: ${code}`,
                    sessionId: effectiveSessionId
                });
            }

            console.log('─'.repeat(60));
            res.end();
        });

        // 进程错误
        claudeProcess.on('error', (err) => {
            if (closed) return;
            closed = true;
            clearTimeout(timeoutId);
            console.error(`[${formatTimestamp()}] [ERROR] 进程错误: ${err.message}`);

            // 清理去重集合和隔离工作目录
            cleanupTempWorkDir(tempWorkDir, effectiveSessionId);

            sendEvent(res, 'error', { message: err.message });
            res.end();
        });

        // 通过 stdin 传递任务内容
        claudeProcess.stdin.write(taskContent);
        claudeProcess.stdin.end();

        // 处理客户端断开连接
        res.on('close', () => {
            if (!closed) {
                console.log(`[${formatTimestamp()}] [CLIENT] 客户端断开连接`);
                closed = true;
                clearTimeout(timeoutId);
                claudeProcess.kill();
                // 清理隔离工作目录
                cleanupTempWorkDir(tempWorkDir, effectiveSessionId);
            }
        });

    } catch (error) {
        console.error(`[${formatTimestamp()}] [ERROR] ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
        // 清理隔离工作目录
        if (typeof effectiveSessionId !== 'undefined') {
            const tempWorkDir = path.join('uploads', 'sessions', 'session-' + effectiveSessionId);
            cleanupTempWorkDir(tempWorkDir, effectiveSessionId);
        }
        console.log('─'.repeat(60));
    }
});

// 启动服务器
app.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('Claude Code API Server - 安全模式');
    console.log('='.repeat(60));
    console.log(`服务地址: http://localhost:${PORT}`);
    console.log(`安全特性:`);
    console.log('  - sessionId 格式验证 (只允许 UUID)');
    console.log('  - 命令参数安全构建 (防止命令注入)');
    console.log('  - Skill 文件安全解压 (防止路径遍历)');
    console.log('  - 临时文件定期清理');
    console.log('');
    console.log('可用端点:');
    console.log(`  GET  http://localhost:${PORT}/health                 - 健康检查`);
    console.log(`  POST http://localhost:${PORT}/api/task/stream         - 流式任务执行接口 (SSE)`);
    console.log('');
    console.log('流式接口返回 SSE 事件:');
    console.log('  - start: { type: "start", sessionId: "..." }');
    console.log('  - chunk: { type: "chunk", content: "..." }');
    console.log('  - done:  { type: "done", sessionId: "...", duration: ... }');
    console.log('  - error: { type: "error", message: "...", code: "..." }');
    console.log('='.repeat(60));
});
