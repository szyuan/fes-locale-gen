# FES 国际化自动化工具

一个用于自动处理前端国际化的命令行工具，可以自动识别和替换代码中的中文文本，生成语言包，并支持 AI 翻译。

## 功能特性

1. 自动识别和替换中文文本
- 支持 Vue/JS/JSX/TS/TSX 文件
- 处理模板和脚本中的中文
- 自动注入所需的依赖
- 保持代码格式和注释

2. 智能文本处理
- 自动处理模板字符串
- 处理 JSX 属性和文本
- 支持条件表达式
- 处理特殊字符和转义

3. 语言包管理
- 自动生成中文语言包
- 支持 AI 翻译成英文
- 增量更新翻译内容
- 保留已有翻译

## 安装

```bash
npm i -g fes-locale-gen
```

## 使用方法

### 基本使用

```bash
# 处理指定目录
fes-locale-gen -d <目录>

# 排除特定文件或目录
fes-locale-gen -d <目录> -e <排除路径>
# 支持多个排除路径
fes-locale-gen -d <目录> -e <排除路径1> -e <排除路径2>

# 处理单个文件
fes-locale-gen -f <文件路径>
```

### 配置翻译服务

```bash
# 初始化配置文件
fes-locale-gen config init

# 设置 API
fes-locale-gen config set --key <your-api-key> --url <api-url>

# 查看当前配置
fes-locale-gen config list
```

配置项说明：
- API_KEY: API密钥
- API_URL: API地址
- AI_PROMPT: AI翻译提示词，默认为"Translate the following JSON object values from Chinese to English. Keep the keys unchanged"

### 翻译语言包

```bash
# 翻译生成的中文文件
fes-locale-gen translate
```

翻译特性：
- 支持增量翻译，只翻译新增内容
- 自动保留已有翻译
- 分批处理大量文本
- 自动处理特殊格式文本

## 生成的文件

工具会在项目根目录下生成以下文件：

```
locales-generated/
  ├── zh-CN-common.js    # 中文语言包
  ├── en-US-common.js    # 英文语言包（翻译后生成）
  └── errorlog-*.json    # 错误日志（如果有错误）
```

### 错误日志格式
```json
{
  "summary": {
    "totalFiles": 100,
    "processedFiles": 98,
    "errorCount": 2,
    "timestamp": "2024-01-01 10:00:00"
  },
  "errors": [
    {
      "file": "src/pages/index.vue",
      "error": "错误信息",
      "stack": "错误堆栈",
      "time": "2024-01-01 10:00:00"
    }
  ]
}
```

## 使用示例

### 代码转换

```vue
<!-- 转换前 -->
<template>
  <div class="user-info">
    <h1>用户信息</h1>
    <el-button @click="save">保存</el-button>
  </div>
</template>

<!-- 转换后 -->
<template>
  <div class="user-info">
    <h1>{{ $t('_.用户信息') }}</h1>
    <el-button @click="save">{{ $t('_.保存') }}</el-button>
  </div>
</template>
```

### 语言包集成

```javascript
// locales/index.js
import enUSCommon from '../locales-generated/en-US-common';

export default {
    _: enUSCommon,  // 自动生成的翻译
    // 其他手动添加的翻译...
};
```

## 注意事项

1. 特殊场景处理
- 包含点号的文本可能需要手动调整
- 复杂的模板字符串可能需要优化
- 某些动态内容可能需要重新组织

2. 建议事项
- 执行前进行代码提交
- 执行后检查生成的代码
- 审查翻译结果的准确性

3. 安全提示
- 首次运行时会提示确认
- 可以先处理单个文件测试
- 建议先排除不需要处理的目录

## 项目地址

https://github.com/szyuan/fes-locale-gen

欢迎提交 Issue 和 PR！
