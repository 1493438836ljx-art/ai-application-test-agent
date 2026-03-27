const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// 生成 UUID v4
function generateUUID() {
    return crypto.randomUUID();
}

// Claude Code 命令配置（最高权限）
const CLAUDE_FLAGS = '--dangerously-skip-permissions';

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

// 临时存储解压的技能文件
let currentSkillPath = null;

/**
 * 健康检查
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        dangerouslySkipPermission: true,
        mode: 'CLAUDE_DANGEROUS_MODE',
        claudeFlags: CLAUDE_FLAGS
    });
});

/**
 * 格式化时间戳
 */
function formatTimestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * 任务执行接口（通用）
 * 支持的入参：
 * 1. taskContent: 任务内容（String，必填）
 * 2. config: 配置信息（JSON，非必填）
 * 3. skillFile: Skill文件（zip文件，非必填）
 * 4. sessionId: 会话ID（String，非必填）- 用于多轮对话会话持久化
 */
app.post('/api/task', upload.single('skillFile'), async (req, res) => {
    const requestStartTime = Date.now();
    const requestTimestamp = formatTimestamp();
    const { config, sessionId } = req.body;
    let taskContent = req.body.taskContent;  // 使用 let 以便后续修改
    const skillFile = req.file;

    // 验证必填参数
    if (!taskContent) {
        console.log(`[${requestTimestamp}] [REQUEST] 任务执行失败: 缺少 taskContent 参数`);
        return res.status(400).json({ error: 'taskContent参数是必需的' });
    }

    // 记录请求开始日志
    console.log('─'.repeat(60));
    console.log(`[${requestTimestamp}] [REQUEST] 收到任务执行请求`);
    console.log(`  - 任务内容摘要: ${taskContent.substring(0, 100)}${taskContent.length > 100 ? '...' : ''}`);
    console.log(`  - 传入会话ID: ${sessionId || '(无，将创建新会话)'}`);
    console.log(`  - 配置信息: ${config ? '有' : '无'}`);
    console.log(`  - Skill文件: ${skillFile ? skillFile.originalname : '无'}`);

    try {
        // 使用 -p 和 --output-format json 获取结构化输出（包含 session_id）
        let claudeCommand = `claude code -p --output-format json ${CLAUDE_FLAGS}`;

        // 处理 sessionId（多轮会话支持）
        let effectiveSessionId = sessionId && sessionId.trim() !== '' ? sessionId.trim() : null;

        if (effectiveSessionId) {
            // 使用 --resume 参数恢复已有会话
            claudeCommand += ` --resume "${effectiveSessionId}"`;
            console.log(`[${formatTimestamp()}] [SESSION] 恢复会话ID: ${effectiveSessionId}`);
        } else {
            // 新会话：生成 UUID 并使用 --session-id 参数
            // 这样可以确保会话被正确持久化
            effectiveSessionId = generateUUID();
            claudeCommand += ` --session-id "${effectiveSessionId}"`;
            console.log(`[${formatTimestamp()}] [SESSION] 创建新会话ID: ${effectiveSessionId}`);
        }

        // 处理配置信息
        if (config) {
            try {
                const configObj = typeof config === 'string' ? JSON.parse(config) : config;
                // 将配置信息添加到任务内容中
                Object.keys(configObj).forEach(key => {
                    taskContent += `\n\n配置 ${key}: ${JSON.stringify(configObj[key])}`;
                });
                console.log(`[${formatTimestamp()}] [CONFIG] 配置信息已解析，共 ${Object.keys(configObj).length} 项`);
            } catch (e) {
                console.error(`[${formatTimestamp()}] [ERROR] 配置解析失败: ${e.message}`);
            }
        }

        // 处理Skill文件（zip）
        let skillDir = null;
        if (skillFile) {
            try {
                // 解压zip文件
                const zip = new AdmZip(skillFile.path);
                const extractDir = path.resolve(path.join('uploads', 'skill-' + Date.now()));
                zip.extractAllTo(extractDir, true);
                skillDir = extractDir;
                console.log(`[${formatTimestamp()}] [SKILL] Skill文件解压至: ${extractDir}`);

                // 检查skill目录结构，查找skill文件
                const skillFiles = [];
                const manifestPath = path.join(extractDir, 'skill-manifest.yaml');
                const hasManifest = fs.existsSync(manifestPath);

                // 遍历解压目录，查找可能的skill文件
                const files = fs.readdirSync(extractDir);
                files.forEach(file => {
                    const filePath = path.join(extractDir, file);
                    const stat = fs.statSync(filePath);
                    if (stat.isFile()) {
                        skillFiles.push({ name: file, path: filePath });
                    } else if (stat.isDirectory()) {
                        // 检查子目录中的文件
                        const subFiles = fs.readdirSync(filePath);
                        subFiles.forEach(subFile => {
                            skillFiles.push({ name: subFile, path: path.join(filePath, subFile) });
                        });
                    }
                });
                console.log(`[${formatTimestamp()}] [SKILL] 发现文件: ${skillFiles.map(f => f.name).join(', ')}`);

                // 在taskContent中添加明确的skill使用指示
                if (hasManifest) {
                    taskContent += `\n\n---\n请使用以下路径中的自定义Skill: ${extractDir}`;
                    taskContent += `\nSkill清单文件位于: ${manifestPath}`;
                    taskContent += `\n请先读取skill-manifest.yaml了解skill的结构和用法，然后按照其中的定义执行任务。`;
                    taskContent += `\n---`;
                } else {
                    // 没有manifest时，也添加skill目录信息
                    taskContent += `\n\n---\n请使用以下路径中的自定义Skill: ${extractDir}`;
                    taskContent += `\nSkill文件: ${skillFiles.map(f => f.name).join(', ')}`;
                    taskContent += `\n---`;
                }

                // 使用 --add-dir 参数添加 skill 目录访问权限（使用绝对路径）
                // 将Windows路径中的反斜杠替换为正斜杠，避免PowerShell解析问题
                const normalizedPath = extractDir.replace(/\\/g, '/');
                claudeCommand += ` --add-dir "${normalizedPath}"`;
                console.log(`[${formatTimestamp()}] [SKILL] 添加目录参数: --add-dir "${normalizedPath}"`);
            } catch (e) {
                console.error(`[${formatTimestamp()}] [ERROR] Skill文件解压失败: ${e.message}`);
            }
        }

        // 执行Claude命令
        // 注意：不改变 cwd，保持工作目录一致以确保会话持久化正常工作
        const claudeProcess = spawn('powershell.exe', [
            '-ExecutionPolicy', 'Bypass',
            '-Command', claudeCommand
        ], {
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, NODE_ENV: 'production' }
        });

        let output = '';
        let errorOutput = '';
        let responseSent = false; // 标记响应是否已发送

        // 设置超时
        const timeoutId = setTimeout(() => {
            if (responseSent) return;
            responseSent = true;

            const duration = Date.now() - requestStartTime;
            claudeProcess.kill();

            console.log(`[${formatTimestamp()}] [RESPONSE] 任务执行超时`);
            console.log(`  - 会话ID: ${effectiveSessionId}`);
            console.log(`  - 执行耗时: ${duration}ms (已超时)`);
            console.log('─'.repeat(60));

            res.status(504).json({ error: '任务执行超时', sessionId: effectiveSessionId, duration: duration });
        }, 600000); // 10分钟超时

        claudeProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        claudeProcess.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        claudeProcess.on('close', async (code) => {
            clearTimeout(timeoutId); // 清除超时定时器

            if (responseSent) return; // 防止重复发送响应
            responseSent = true;

            const requestEndTime = Date.now();
            const duration = requestEndTime - requestStartTime;

            // 清理临时文件
            if (skillFile && fs.existsSync(skillFile.path)) {
                fs.unlinkSync(skillFile.path);
            }

            if (code === 0) {
                // 尝试解析 JSON 输出提取 result
                let responseResult = output;
                let parsedJson = null;

                try {
                    parsedJson = JSON.parse(output);
                    // 提取 result 字段作为响应内容
                    if (parsedJson.result) {
                        responseResult = parsedJson.result;
                    }
                } catch (e) {
                    // 如果不是 JSON 格式，使用原始输出
                    console.log(`[${formatTimestamp()}] [WARN] 输出不是 JSON 格式，使用原始输出`);
                }

                // 记录成功日志
                console.log(`[${formatTimestamp()}] [RESPONSE] 任务执行成功`);
                console.log(`  - 会话ID: ${effectiveSessionId}`);
                console.log(`  - 执行耗时: ${duration}ms`);
                console.log(`  - 响应内容摘要: ${responseResult.substring(0, 100)}${responseResult.length > 100 ? '...' : ''}`);
                console.log('─'.repeat(60));

                res.json({
                    success: true,
                    response: responseResult,
                    taskContent,
                    config: config ? JSON.stringify(config) : null,
                    skillFile: skillFile ? skillFile.originalname : null,
                    sessionId: effectiveSessionId,
                    rawOutput: parsedJson, // 返回完整解析结果供调试
                    duration: duration
                });
            } else {
                // 记录失败日志
                console.log(`[${formatTimestamp()}] [RESPONSE] 任务执行失败`);
                console.log(`  - 会话ID: ${effectiveSessionId}`);
                console.log(`  - 执行耗时: ${duration}ms`);
                console.log(`  - 退出码: ${code}`);
                console.log(`  - 错误信息: ${errorOutput || '任务执行失败'}`);
                console.log('─'.repeat(60));

                res.status(500).json({
                    success: false,
                    error: errorOutput || '任务执行失败',
                    code,
                    taskContent,
                    sessionId: effectiveSessionId,
                    duration: duration
                });
            }
        });

        // 通过 stdin 传递任务内容
        claudeProcess.stdin.write(taskContent);
        claudeProcess.stdin.end();

    } catch (error) {
        const duration = Date.now() - requestStartTime;
        // 清理临时文件
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        console.log(`[${formatTimestamp()}] [RESPONSE] 任务执行异常`);
        console.log(`  - 错误信息: ${error.message}`);
        console.log(`  - 执行耗时: ${duration}ms`);
        console.log('─'.repeat(60));
        res.status(500).json({ error: error.message, duration: duration });
    }
});

/**
 * 流式任务执行接口
 * 使用 SSE (Server-Sent Events) 实时返回 Claude Code 的输出
 * 支持的入参与 /api/task 相同
 */
app.post('/api/task/stream', upload.single('skillFile'), async (req, res) => {
    const requestStartTime = Date.now();
    const requestTimestamp = formatTimestamp();
    const { config, sessionId } = req.body;
    let taskContent = req.body.taskContent;
    const skillFile = req.file;

    // 验证必填参数
    if (!taskContent) {
        console.log(`[${requestTimestamp}] [STREAM] 任务执行失败: 缺少 taskContent 参数`);
        return res.status(400).json({ error: 'taskContent参数是必需的' });
    }

    // 记录请求开始日志
    console.log('─'.repeat(60));
    console.log(`[${requestTimestamp}] [STREAM] 收到流式任务执行请求`);
    console.log(`  - 任务内容摘要: ${taskContent.substring(0, 100)}${taskContent.length > 100 ? '...' : ''}`);
    console.log(`  - 传入会话ID: ${sessionId || '(无，将创建新会话)'}`);

    // 设置 SSE 响应头
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    // 连接状态标志 - 必须在 sendEvent 函数之前定义
    let closed = false;

    // 发送 SSE 辅助函数（带错误处理）
    const sendEvent = (type, data = {}) => {
        try {
            if (closed) {
                console.log(`[${formatTimestamp()}] [STREAM] 跳过发送，连接已关闭, type=${type}`);
                return false;
            }
            const message = `data: ${JSON.stringify({ type, ...data })}\n\n`;
            const writeResult = res.write(message);
            console.log(`[${formatTimestamp()}] [STREAM] 发送事件: type=${type}, writeResult=${writeResult}`);

            // 立即刷新缓冲区，确保数据实时发送
            if (typeof res.flush === 'function') {
                res.flush();
                console.log(`[${formatTimestamp()}] [STREAM] 缓冲区已刷新`);
            }
            return true;
        } catch (writeError) {
            console.error(`[${formatTimestamp()}] [STREAM ERROR] 写入失败: ${writeError.message}`);
                closed = true;
                return false;
            }
    };

    try {
        // 构建流式命令 (--verbose 是 stream-json 所必需的)
        let claudeCommand = `claude code -p --output-format stream-json --verbose ${CLAUDE_FLAGS}`;

        // 处理 sessionId
        let effectiveSessionId = sessionId && sessionId.trim() !== '' ? sessionId.trim() : null;

        if (effectiveSessionId) {
            claudeCommand += ` --resume "${effectiveSessionId}"`;
            console.log(`[${formatTimestamp()}] [STREAM] 恢复会话ID: ${effectiveSessionId}`);
        } else {
            effectiveSessionId = generateUUID();
            claudeCommand += ` --session-id "${effectiveSessionId}"`;
            console.log(`[${formatTimestamp()}] [STREAM] 创建新会话ID: ${effectiveSessionId}`);
        }

        // 处理配置信息
        if (config) {
            try {
                const configObj = typeof config === 'string' ? JSON.parse(config) : config;
                Object.keys(configObj).forEach(key => {
                    taskContent += `\n\n配置 ${key}: ${JSON.stringify(configObj[key])}`;
                });
            } catch (e) {
                console.error(`[${formatTimestamp()}] [STREAM ERROR] 配置解析失败: ${e.message}`);
            }
        }

        // 处理 Skill 文件
        let skillDir = null;
        if (skillFile) {
            try {
                const zip = new AdmZip(skillFile.path);
                const extractDir = path.resolve(path.join('uploads', 'skill-' + Date.now()));
                zip.extractAllTo(extractDir, true);
                skillDir = extractDir;
                console.log(`[${formatTimestamp()}] [STREAM] Skill文件解压至: ${extractDir}`);

                const manifestPath = path.join(extractDir, 'skill-manifest.yaml');
                if (fs.existsSync(manifestPath)) {
                    taskContent += `\n\n---\n请使用以下路径中的自定义Skill: ${extractDir}`;
                    taskContent += `\nSkill清单文件位于: ${manifestPath}`;
                    taskContent += `\n---`;
                }

                const normalizedPath = extractDir.replace(/\\/g, '/');
                claudeCommand += ` --add-dir "${normalizedPath}"`;
            } catch (e) {
                console.error(`[${formatTimestamp()}] [STREAM ERROR] Skill文件解压失败: ${e.message}`);
            }
        }

        // 发送开始事件
        sendEvent('start', { sessionId: effectiveSessionId });

        // 执行 Claude 命令
        const claudeProcess = spawn('powershell.exe', [
            '-ExecutionPolicy', 'Bypass',
            '-Command', claudeCommand
        ], {
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, NODE_ENV: 'production' }
        });

        // 设置超时
        const timeoutId = setTimeout(() => {
            if (closed) return;
            closed = true;
            claudeProcess.kill();
            sendEvent('error', { message: '任务执行超时' });
            res.end();
            console.log(`[${formatTimestamp()}] [STREAM] 任务执行超时`);
        }, 600000);

        // 辅助函数：从 Claude stream-json 格式中提取文本内容
        // 返回 { content, contentType } 或 null
        // contentType: 'thinking' | 'text' | 'tool_use' | 'result'
        const extractContent = (parsed) => {
            // 直接文本输出
            if (parsed.type === 'result' && parsed.result) {
                return { content: parsed.result, contentType: 'result' };
            }

            // assistant 消息，需要从 message.content 数组提取
            if (parsed.type === 'assistant' && parsed.message?.content) {
                const results = [];
                for (const block of parsed.message.content) {
                    if (block.type === 'thinking' && block.thinking) {
                        results.push({ content: block.thinking, contentType: 'thinking' });
                    } else if (block.type === 'text' && block.text) {
                        results.push({ content: block.text, contentType: 'text' });
                    } else if (block.type === 'tool_use') {
                        results.push({
                            content: `使用工具: ${block.name}`,
                            contentType: 'tool_use',
                            toolName: block.name,
                            toolInput: block.input
                        });
                    }
                }
                // 如果有多个块，返回第一个（通常只有一个主要块）
                return results.length > 0 ? results[0] : null;
            }

            // content_block_delta 类型
            if (parsed.type === 'content_block_delta' && parsed.delta) {
                if (parsed.delta.type === 'thinking_delta' && parsed.delta.thinking) {
                    return { content: parsed.delta.thinking, contentType: 'thinking' };
                } else if (parsed.delta.type === 'text_delta' && parsed.delta.text) {
                    return { content: parsed.delta.text, contentType: 'text' };
                }
            }

            // 其他情况，返回 null 表示不发送
            return null;
        };

        // 实时流式输出 stdout
        claudeProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            // 尝试解析 stream-json 格式的输出
            const lines = chunk.split('\n').filter(line => line.trim());
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);

                    // 跳过 system/init 类型的消息，不需要发送给用户
                    if (parsed.type === 'system') {
                        console.log(`[${formatTimestamp()}] [STREAM] 跳过 system 消息: subtype=${parsed.subtype}`);
                        continue;
                    }

                    // 提取实际内容
                    const extracted = extractContent(parsed);
                    if (extracted) {
                        sendEvent('chunk', {
                            content: extracted.content,
                            contentType: extracted.contentType,
                            toolName: extracted.toolName,
                            toolInput: extracted.toolInput
                        });
                    }
                } catch (e) {
                    // 不是 JSON，直接发送原始内容
                    if (line.trim()) {
                        sendEvent('chunk', { content: line });
                    }
                }
            }
        });

        // 处理 stderr
        claudeProcess.stderr.on('data', (data) => {
            const chunk = data.toString();
            console.error(`[${formatTimestamp()}] [STREAM STDERR] ${chunk}`);
            // 不作为错误发送，因为 Claude 可能会在 stderr 输出一些信息性内容
        });

        // 进程结束
        claudeProcess.on('close', (code) => {
            if (closed) return;
            closed = true;
            clearTimeout(timeoutId);

            const duration = Date.now() - requestStartTime;

            // 清理临时文件
            if (skillFile && fs.existsSync(skillFile.path)) {
                fs.unlinkSync(skillFile.path);
            }

            if (code === 0) {
                console.log(`[${formatTimestamp()}] [STREAM] 任务执行成功，耗时: ${duration}ms`);
                sendEvent('done', { sessionId: effectiveSessionId, duration });
            } else {
                console.log(`[${formatTimestamp()}] [STREAM] 任务执行失败，退出码: ${code}`);
                sendEvent('error', { message: `任务执行失败，退出码: ${code}`, sessionId: effectiveSessionId });
            }

            console.log('─'.repeat(60));
            res.end();
        });

        // 进程错误
        claudeProcess.on('error', (err) => {
            if (closed) return;
            closed = true;
            clearTimeout(timeoutId);
            console.error(`[${formatTimestamp()}] [STREAM ERROR] 进程错误: ${err.message}`);
            sendEvent('error', { message: err.message });
            res.end();
        });

        // 通过 stdin 传递任务内容
        claudeProcess.stdin.write(taskContent);
        claudeProcess.stdin.end();

        // 处理客户端断开连接 - 对于 SSE 应该监听 res.on('close')
        // 注意：req.on('close') 对于 POST 请求会在请求体接收完成时触发，而不是客户端断开时
        res.on('close', () => {
            if (!closed) {
                console.log(`[${formatTimestamp()}] [STREAM] 客户端断开连接 (res.on('close') 触发)`);
                closed = true;
                clearTimeout(timeoutId);
                claudeProcess.kill();
            }
        });

        // 同时监听 socket 关闭事件作为备用
        req.socket.on('close', () => {
            if (!closed) {
                console.log(`[${formatTimestamp()}] [STREAM] Socket 关闭`);
                closed = true;
                clearTimeout(timeoutId);
                claudeProcess.kill();
            }
        });

    } catch (error) {
        const duration = Date.now() - requestStartTime;
        console.error(`[${formatTimestamp()}] [STREAM ERROR] ${error.message}`);
        sendEvent('error', { message: error.message });
        res.end();

        if (skillFile && fs.existsSync(skillFile.path)) {
            fs.unlinkSync(skillFile.path);
        }
        console.log('─'.repeat(60));
    }
});

// 启动服务器
app.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('Claude Code API Server - 危险模式');
    console.log('='.repeat(60));
    console.log(`服务地址: http://localhost:${PORT}`);
    console.log(`权限模式: DANGEROUS_MODE (跳过所有权限检查)`);
    console.log(`Claude标志: ${CLAUDE_FLAGS}`);
    console.log('');
    console.log('⚠️  警告: 此模式跳过所有Claude Code权限检查');
    console.log('⚠️  警告: 所有命令将以最高权限执行');
    console.log('');
    console.log('可用端点:');
    console.log(`  GET  http://localhost:${PORT}/health                 - 健康检查`);
    console.log(`  POST http://localhost:${PORT}/api/task                - 通用任务执行接口`);
    console.log(`  POST http://localhost:${PORT}/api/task/stream         - 流式任务执行接口 (SSE)`);
    console.log('');
    console.log('任务执行接口参数:');
    console.log('  - taskContent (必填): 任务内容字符串');
    console.log('  - config (可选): 配置信息JSON');
    console.log('  - skillFile (可选): Skill文件zip格式');
    console.log('  - sessionId (可选): 会话ID，用于多轮对话会话持久化');
    console.log('');
    console.log('流式接口 (/api/task/stream) 返回 SSE 事件:');
    console.log('  - start: { type: "start", sessionId: "..." }');
    console.log('  - chunk: { type: "chunk", content: "..." }');
    console.log('  - done:  { type: "done", sessionId: "...", duration: ... }');
    console.log('  - error: { type: "error", message: "..." }');
    console.log('');
    console.log('多轮会话使用方式:');
    console.log('  1. 首次调用不传 sessionId，响应中会返回新创建的 sessionId');
    console.log('  2. 后续调用传入该 sessionId，即可恢复之前的对话上下文');
    console.log('='.repeat(60));
});
