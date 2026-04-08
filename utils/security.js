/**
 * 安全工具模块
 * 提供 sessionId 验证、路径验证等安全功能
 */

const path = require('path');
const fs = require('fs');

/**
 * 验证 sessionId 格式
 * 只允许 UUID v4 格式
 *
 * @param {string} sessionId - 要验证的 sessionId
 * @returns {boolean} - 是否有效
 */
function isValidSessionId(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
        return false;
    }
    // UUID v4 格式: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(sessionId.trim());
}

/**
 * 验证路径安全性（防止路径遍历）
 *
 * @param {string} inputPath - 要验证的路径
 * @param {string} baseDir - 基础目录
 * @returns {string} - 安全的绝对路径
 * @throws {Error} - 如果检测到路径遍历攻击
 */
function validatePath(inputPath, baseDir) {
    // 规范化路径
    const normalized = path.normalize(inputPath);
    const resolved = path.resolve(baseDir, normalized);
    const absoluteBaseDir = path.resolve(baseDir);

    // 检查是否以 .. 开头
    if (normalized.startsWith('..') || normalized.includes(path.sep + '..')) {
        throw new Error(`Path traversal detected: ${inputPath}`);
    }

    // 检查是否为绝对路径
    if (path.isAbsolute(normalized)) {
        throw new Error(`Absolute path not allowed: ${inputPath}`);
    }

    // 检查最终路径是否在基础目录内
    if (!resolved.startsWith(absoluteBaseDir)) {
        throw new Error(`Path traversal attempt: ${inputPath}`);
    }

    return resolved;
}

/**
 * 安全解压 ZIP 文件
 * 防止路径遍历、超大文件等攻击
 */
class SafeZipExtractor {
    constructor(targetDir) {
        this.targetDir = path.resolve(targetDir);
        this.maxFileSize = 10 * 1024 * 1024; // 10MB
        this.maxTotalSize = 50 * 1024 * 1024; // 50MB
        this.allowedExtensions = [
            '.yaml', '.yml', '.json', '.md', '.txt',
            '.js', '.ts', '.py', '.java', '.go',
            '.xml', '.properties', '.conf'
        ];
    }

    /**
     * 安全解压
     *
     * @param {string} zipPath - ZIP 文件路径
     * @returns {Object} - 解压结果
     */
    extract(zipPath) {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries();

        let totalSize = 0;
        const extractedFiles = [];

        // 第一轮：验证所有条目
        for (const entry of entries) {
            // 1. 检查路径遍历
            if (this.isPathTraversal(entry.entryName)) {
                throw new Error(`Unsafe path detected: ${entry.entryName}`);
            }

            // 2. 检查文件大小
            if (entry.header.size > this.maxFileSize) {
                throw new Error(`File too large: ${entry.entryName} (${entry.header.size} bytes)`);
            }

            totalSize += entry.header.size;

            // 3. 检查总大小
            if (totalSize > this.maxTotalSize) {
                throw new Error(`Total extracted size exceeds limit (${totalSize} bytes)`);
            }

            // 4. 检查文件扩展名
            if (!entry.isDirectory && !this.isAllowedExtension(entry.entryName)) {
                console.warn(`[SafeZipExtractor] Skipping file with disallowed extension: ${entry.entryName}`);
                continue;
            }

            extractedFiles.push(entry);
        }

        // 确保 targetDir 存在
        if (!fs.existsSync(this.targetDir)) {
            fs.mkdirSync(this.targetDir, { recursive: true });
        }

        // 第二轮：安全解压
        for (const entry of extractedFiles) {
            if (entry.isDirectory) {
                continue;
            }

            const targetPath = this.getSafePath(entry.entryName);

            // 确保父目录存在
            const parentDir = path.dirname(targetPath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }

            // 解压文件
            fs.writeFileSync(targetPath, entry.getData());
            console.log(`[SafeZipExtractor] Extracted: ${entry.entryName}`);
        }

        return {
            targetDir: this.targetDir,
            files: extractedFiles.map(e => e.entryName)
        };
    }

    /**
     * 检查路径遍历攻击
     *
     * @param {string} entryName - ZIP 条目名称
     * @returns {boolean} - 是否为路径遍历攻击
     */
    isPathTraversal(entryName) {
        // 规范化路径
        const normalized = path.normalize(entryName);

        // 检查是否以 .. 开头或包含 ..
        if (normalized.startsWith('..') || normalized.includes(path.sep + '..')) {
            return true;
        }

        // 检查绝对路径
        if (path.isAbsolute(normalized)) {
            return true;
        }

        // 检查最终路径是否在目标目录内
        const resolved = path.resolve(this.targetDir, normalized);
        if (!resolved.startsWith(this.targetDir)) {
            return true;
        }

        return false;
    }

    /**
     * 获取安全的目标路径
     *
     * @param {string} entryName - ZIP 条目名称
     * @returns {string} - 安全的目标路径
     */
    getSafePath(entryName) {
        const normalized = path.normalize(entryName);
        const resolved = path.resolve(this.targetDir, normalized);

        // 再次验证
        if (!resolved.startsWith(this.targetDir)) {
            throw new Error(`Path traversal attempt: ${entryName}`);
        }

        return resolved;
    }

    /**
     * 检查是否为允许的扩展名
     *
     * @param {string} filename - 文件名
     * @returns {boolean} - 是否允许
     */
    isAllowedExtension(filename) {
        const ext = path.extname(filename).toLowerCase();
        return this.allowedExtensions.includes(ext);
    }
}

/**
 * 清理过期的临时文件
 *
 * @param {string} baseDir - 基础目录
 * @param {number} maxAgeMs - 最大存活时间（毫秒），默认 24 小时
 */
function cleanupExpiredFiles(baseDir, maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();

    if (!fs.existsSync(baseDir)) {
        return;
    }

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(baseDir, entry.name);
        const stat = fs.statSync(fullPath);

        if (now - stat.mtimeMs > maxAgeMs) {
            if (entry.isDirectory()) {
                fs.rmSync(fullPath, { recursive: true });
                console.log(`[Cleanup] Cleaned up directory: ${fullPath}`);
            } else {
                fs.unlinkSync(fullPath);
                console.log(`[Cleanup] Cleaned up file: ${fullPath}`);
            }
        }
    }
}

/**
 * 构建安全的 Claude CLI 参数数组
 * 使用参数数组而非字符串拼接，防止命令注入
 *
 * @param {Object} options - 选项
 * @returns {string[]} - 参数数组
 */
function buildClaudeArgs(options) {
    // 支持通过环境变量 CLAUDE_CODE_PATH 指定 claude 命令的完整路径
    // 如果没有设置，尝试自动检测
    let claudeCommand = process.env.CLAUDE_CODE_PATH;

    if (!claudeCommand) {
        // 尝试常见的安装位置
        const path = require('path');
        const fs = require('fs');

        const possiblePaths = [
            // Windows npm 全局安装位置
            path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
            path.join(process.env.APPDATA || '', 'npm', 'claude'),
            // 用户目录下的 .claude
            path.join(process.env.USERPROFILE || '', '.claude', 'bin', 'claude.cmd'),
            path.join(process.env.USERPROFILE || '', '.claude', 'bin', 'claude'),
            // Linux/macOS 常见位置
            '/usr/local/bin/claude',
            '/usr/bin/claude',
            path.join(process.env.HOME || '', '.local', 'bin', 'claude')
        ];

        for (const p of possiblePaths) {
            if (p && fs.existsSync(p)) {
                claudeCommand = p;
                console.log(`[buildClaudeArgs] 自动检测到 Claude CLI: ${p}`);
                break;
            }
        }
    }

    // 如果还是找不到，使用默认值（让系统从 PATH 中查找）
    if (!claudeCommand) {
        claudeCommand = 'claude';
        console.log('[buildClaudeArgs] 使用默认 claude 命令，请确保在 PATH 中');
    }

    const args = [claudeCommand, 'code', '-p'];

    // 输出格式
    args.push('--output-format', options.outputFormat || 'stream-json');

    // 详细模式
    if (options.verbose) {
        args.push('--verbose');
    }

    // 危险标志（生产环境应该移除）
    if (options.dangerouslySkipPermissions) {
        args.push('--dangerously-skip-permissions');
    }

    // 会话ID（新会话）
    if (options.sessionId && !options.resume) {
        // 验证 sessionId 格式
        if (!isValidSessionId(options.sessionId)) {
            throw new Error(`Invalid session ID format: ${options.sessionId}`);
        }
        args.push('--session-id', options.sessionId);
    }

    // 恢复会话
    if (options.resume && options.sessionId) {
        if (!isValidSessionId(options.sessionId)) {
            throw new Error(`Invalid session ID format: ${options.sessionId}`);
        }
        args.push('--resume', options.sessionId);
    }

    // Skill 目录
    // 方案 A：使用隔离工作目录时，skillDir 是相对于隔离目录的路径
    // 如果提供了绝对路径的 skillDir，使用 --add-dir 参数
    // 如果 skillDir 在隔离工作目录中，可以省略 --add-dir（因为 cwd 已经是隔离目录）
    if (options.skillDir) {
        // 检查是否是隔离工作目录中的相对路径
        if (options.skillDir.includes(path.sep + 'sessions' + path.sep + 'session-')) {
            // 这是隔离工作目录中的 skill 目录，使用相对路径 ./skill
            args.push('--add-dir', './skill');
            console.log(`[buildClaudeArgs] 使用隔离目录中的 Skill: ./skill`);
        } else if (fs.existsSync(options.skillDir)) {
            // 传统的绝对路径方式
            args.push('--add-dir', options.skillDir);
            console.log(`[buildClaudeArgs] 添加 Skill 目录: ${options.skillDir}`);
        } else {
            throw new Error(`Skill directory does not exist: ${options.skillDir}`);
        }
    }

    return args;
}

module.exports = {
    isValidSessionId,
    validatePath,
    SafeZipExtractor,
    cleanupExpiredFiles,
    buildClaudeArgs
};
