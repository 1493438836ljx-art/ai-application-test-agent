/**
 * 安全解压工具类
 * 防止路径遍历攻击，限制文件大小和类型
 */

const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');

class SafeZipExtractor {
    constructor(targetDir) {
        this.targetDir = path.resolve(targetDir);
        this.maxFileSize = 10 * 1024 * 1024; // 10MB
        this.maxTotalSize = 50 * 1024 * 1024; // 50MB
        this.allowedExtensions = [
            '.yaml', '.yml', '.json', '.md', '.txt',
            '.js', '.ts', '.py', '.java', '.go',
            '.xml', '.properties', '.conf', '.sh', '.bash'
        ];
    }

    /**
     * 安全解压 ZIP 文件
     *
     * @param {string} zipPath - ZIP 文件路径
     * @returns {Object} - 解压结果
     * @throws {Error} - 如果检测到安全问题
     */
    extract(zipPath) {
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
                throw new Error(`File too large: ${entry.entryName} (${(entry.header.size / 1024 / 1024).toFixed(2)}MB > 10MB limit)`);
            }

            totalSize += entry.header.size;

            // 3. 检查总大小
            if (totalSize > this.maxTotalSize) {
                throw new Error(`Total extracted size exceeds limit (50MB)`);
            }

            // 4. 检查文件扩展名
            if (!entry.isDirectory && !this.isAllowedExtension(entry.entryName)) {
                console.warn(`[Security] Skipping file with disallowed extension: ${entry.entryName}`);
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
            console.log(`[Extract] Extracted: ${entry.entryName}`);
        }

        return {
            targetDir: this.targetDir,
            files: extractedFiles.filter(e => !e.isDirectory).map(e => e.entryName)
        };
    }

    /**
     * 检查路径遍历攻击
     *
     * @param {string} entryName - ZIP 条目名称
     * @returns {boolean} - 是否检测到路径遍历
     */
    isPathTraversal(entryName) {
        // 规范化路径
        const normalized = path.normalize(entryName);

        // 检查是否以 .. 开头
        if (normalized.startsWith('..')) {
            return true;
        }

        // 检查是否包含 ..
        if (normalized.includes(path.sep + '..') || normalized.includes('/..')) {
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
     * @returns {string} - 安全的绝对路径
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

module.exports = SafeZipExtractor;
