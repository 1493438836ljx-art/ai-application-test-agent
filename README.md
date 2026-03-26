# Claude Code RESTful API - 危险模式

将Claude Code封装成可通过Postman调用的RESTful API服务，使用 `--dangerously-skip-permissions` 标志跳过所有权限检查。

## 警告

> ⚠️ **危险模式**：此API使用 `--dangerously-skip-permissions` 标志，跳过所有Claude Code权限检查。可以执行任何系统命令、读写任何文件。请谨慎使用！

## 安装

```bash
npm install
```

## 启动服务

```bash
npm start
```

服务将在 `http://localhost:3000` 启动。

## 权限模式

- **Claude标志**: `--dangerously-skip-permissions` (跳过所有权限检查)
- **文件访问**: 无限制

## API 端点

### 1. 健康检查

```
GET /health
```

**响应示例：**
```json
{
  "status": "ok",
  "uptime": 123.456,
  "dangerouslySkipPermission": true,
  "mode": "CLAUDE_DANGEROUS_MODE",
  "claudeFlags": "--dangerously-skip-permissions"
}
```

---

### 2. 通用任务执行接口

执行Claude Code任务，支持任务内容、配置信息和Skill文件。

```
POST /api/task
Content-Type: multipart/form-data
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|--------|------|
| taskContent | String | 是 | 任务内容 |
| config | JSON | 否 | 配置信息 |
| skillFile | File (zip) | 否 | Skill文件 |

**Postman 配置：**
- Body 类型选择: `form-data`
- 添加字段:
  - `taskContent`: Text 类型，输入任务内容
  - `config`: Text 类型，输入JSON配置（可选）
  - `skillFile`: File 类型，选择zip文件（可选）

**请求示例（cURL）：**
```bash
# 基础请求（仅任务内容）
curl -X POST http://localhost:3000/api/task \
  -H "Content-Type: multipart/form-data" \
  -F "taskContent=列出当前目录所有文件"

# 带配置的请求
curl -X POST http://localhost:3000/api/task \
  -H "Content-Type: multipart/form-data" \
  -F "taskContent=创建一个hello world文件" \
  -F "config={\"timeout\":60,\"debug\":false}"

# 带Skill文件的请求
curl -X POST http://localhost:3000/api/task \
  -H "Content-Type: multipart/form-data" \
  -F "taskContent=使用自定义Skill执行任务" \
  -F "skillFile=@custom-skill.zip"
```

**响应示例（成功）：**
```json
{
  "success": true,
  "response": "已创建hello.txt文件\n\n列出目录:\nindex.js\npackage.json\n...",
  "taskContent": "创建一个hello world文件",
  "config": "{\"timeout\":60,\"debug\":false}",
  "skillFile": "custom-skill.zip"
}
```

**响应示例（失败）：**
```json
{
  "success": false,
  "error": "命令执行失败",
  "code": 1,
  "taskContent": "创建一个hello world文件"
}
```

## Postman 导入

将以下JSON保存为 `Claude-Code-API.postman_collection.json` 并导入Postman：

```json
{
  "info": {
    "name": "Claude Code API - 危险模式",
    "description": "使用 --dangerously-skip-permissions 标志执行Claude Code命令",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "variable": [
    {
      "key": "baseUrl",
      "value": "http://localhost:3000"
    }
  ],
  "item": [
    {
      "name": "Health Check",
      "request": {
        "method": "GET",
        "url": "{{baseUrl}}/health"
      }
    },
    {
      "name": "Task Execute (Simple)",
      "request": {
        "method": "POST",
        "header": [],
        "url": "{{baseUrl}}/api/task",
        "body": {
          "mode": "formdata",
          "formdata": [
            {
              "key": "taskContent",
              "type": "text",
              "value": "列出当前目录所有文件"
            }
          ]
        }
      }
    },
    {
      "name": "Task Execute (With Config)",
      "request": {
        "method": "POST",
        "header": [],
        "url": "{{baseUrl}}/api/task",
        "body": {
          "mode": "formdata",
          "formdata": [
            {
              "key": "taskContent",
              "type": "text",
              "value": "创建一个hello world文件"
            },
            {
              "key": "config",
              "type": "text",
              "value": "{\"timeout\":60,\"debug\":false}"
            }
          ]
        }
      }
    },
    {
      "name": "Task Execute (With Skill)",
      "request": {
        "method": "POST",
        "header": [],
        "url": "{{baseUrl}}/api/task",
        "body": {
          "mode": "formdata",
          "formdata": [
            {
              "key": "taskContent",
              "type": "text",
              "value": "使用自定义Skill执行任务"
            },
            {
              "key": "skillFile",
              "type": "file",
              "src": "/path/to/your/skill.zip"
            }
          ]
        }
      }
    }
  ]
}
```

## 注意事项

1. **危险模式风险**：此API使用 `--dangerously-skip-permissions` 标志，跳过所有Claude Code权限检查
2. 确保Claude CLI已在系统PATH中可用
3. 默认端口为3000，可通过环境变量 `PORT` 修改
4. 请求超时时间为2分钟（120秒）
5. Windows系统使用PowerShell执行命令，绕过执行策略
6. 建议**仅在内网环境或测试环境**使用此API
7. 上传的Skill文件会被自动解压到 `uploads` 目录，任务执行完成后自动清理

## 错误码

| HTTP状态码 | 说明 |
|------------|------|
| 200 | 执行成功 |
| 400 | 参数错误（缺少必填参数） |
| 500 | 执行失败 |
| 504 | 执行超时 |
