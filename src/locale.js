#!/usr/bin/env node

// 清理 require 缓存
Object.keys(require.cache).forEach(function(key) { delete require.cache[key] });

const fs = require('fs');
const { parse } = require('vue-eslint-parser');
const path = require('path');
const glob = require('glob');
const minimist = require('minimist');
const { parse: parseJS } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const dotenv = require('dotenv');
const { OpenAI } = require('openai');

// 解析命令行参数
const args = minimist(process.argv.slice(2), {
    string: ['key', 'url'],
    alias: {
        f: 'file',
        d: 'directory',
        e: 'exclude',
    },
    default: {
        f: null,
        d: './',
        e: [],
    },
});

// 确保排除的目录总是一个数组
if (!Array.isArray(args.e)) {
    args.e = [args.e];
}

function readTemplate(filePath) {
    const inputFileContent = fs.readFileSync(filePath, 'utf-8');
    let ast = null;
    try {
        ast = parse(inputFileContent, {
            ecmaVersion: 2020,
            sourceType: 'module',
            ecmaFeatures: {
                jsx: true,
            },
        });
        // console.log('parse completed');
    } catch (e) {
        console.error('ast解析出错: ', filePath, e);
    }
    return {
        inputFileContent,
        ast,
    };
}

// 总文本收集
const replacedTexts = new Set();

function escapeForTranslation(str) {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function processJavaScript(code, isModule = true) {
    try {
        let ast = parseJS(code, {
            sourceType: isModule ? 'module' : 'script',
            plugins: ['jsx'],
        });

        const replacements = [];
        let lastImportIndex = -1;

        // 第一次遍历：进行替换
        traverse(ast, {
            CallExpression(path) {
                if (path.node.callee.type === 'MemberExpression' &&
                    path.node.callee.object.name === 'console') {
                    path.skip();
                }
                if (path.node.callee.name === '$t') {
                    path.skip();
                }
            },
            StringLiteral(path) {
                if (/[\u4e00-\u9fa5]/.test(path.node.value) && 
                    !path.findParent(p => p.isCallExpression() && p.node.callee.name === '$t') &&
                    !path.node.value.startsWith('_.$t(') &&
                    !path.node.value.match(/^\$t\('_\.[^']+'\)$/) &&
                    !path.findParent((p) => p.isCallExpression() && p.node.callee.type === 'MemberExpression' && p.node.callee.object.name === 'console')) {
                    const text = path.node.value;
                    replacedTexts.add(text);
                    const escapedText = escapeForTranslation(text);
                    replacements.push({
                        start: path.node.start,
                        end: path.node.end,
                        text: `$t('_.${escapedText}')`
                    });
                }
            },
            TemplateLiteral(path) {
                // ... 保持不变
            }
        });

        // 应用替换
        replacements.sort((a, b) => b.start - a.start);
        for (const { start, end, text } of replacements) {
            code = code.slice(0, start) + text + code.slice(end);
        }

        // 如果有替换，进行第二次和第三次遍历
        if (replacements.length > 0) {
            ast = parseJS(code, {
                sourceType: isModule ? 'module' : 'script',
                plugins: ['jsx'],
            });

            let hasUseI18nImport = false;
            let existingFesImport = null;

            // 第二次遍历：检查是否引入 useI18n
            traverse(ast, {
                ImportDeclaration(path) {
                    if (path.node.source.value === '@fesjs/fes') {
                        existingFesImport = path.node;
                        hasUseI18nImport = path.node.specifiers.some(spec => 
                            spec.type === 'ImportSpecifier' && 
                            spec.imported.name === 'useI18n');
                    }
                }
            });

            // 添加 useI18n 导入（如果需要）
            if (!hasUseI18nImport) {
                if (existingFesImport) {
                    const importStart = existingFesImport.start;
                    const importEnd = existingFesImport.end;
                    const newImport = generate(existingFesImport).code.replace(/}(?=[^}]*$)/, ', useI18n }');
                    code = code.slice(0, importStart) + newImport + code.slice(importEnd);
                } else {
                    code =`import { useI18n } from '@fesjs/fes';\n` + code;
                }
            }

            ast = parseJS(code, {
                sourceType: isModule ? 'module' : 'script',
                plugins: ['jsx'],
            });

            let hasDollarTDeclaration = false;

            // 第三次遍历：检查是否有使用插件
            traverse(ast, {
                ImportDeclaration(path) {
                    lastImportIndex = Math.max(lastImportIndex, path.node.loc.end.line);
                },
                VariableDeclaration(path) {
                    path.node.declarations.forEach(declaration => {
                        if (declaration.init && 
                            declaration.init.type === 'CallExpression' &&
                            declaration.init.callee.name === 'useI18n') {
                            if (declaration.id.type === 'ObjectPattern') {
                                const tProperty = declaration.id.properties.find(prop => 
                                    prop.key.name === 't' && prop.value.name === '$t'
                                );
                                if (tProperty) {
                                    hasDollarTDeclaration = true;
                                }
                            }
                        }
                    });
                }
            });

            // 添加 $t 声明（如果需要）
            if (!hasDollarTDeclaration) {
                const lines = code.split('\n');
                const insertIndex = lastImportIndex !== -1 ? lastImportIndex + 1 : 0;
                lines.splice(insertIndex, 0, `\nconst { t: $t } = useI18n();\n`);
                code = lines.join('\n');
            }
        }

        return code;
    } catch (error) {
        console.error('处理 JavaScript 时出错:', error);
        return code;
    }
}

function traverseTemplate(node, replacements) {
    if (node.type === 'VText' && /[\u4e00-\u9fa5]/.test(node.value)) {
        handleTextNode(node, replacements);
    } else if (node.type === 'VElement' && node.startTag && node.startTag.attributes) {
        for (const attr of node.startTag.attributes) {
            if (attr.value && /[\u4e00-\u9fa5]/.test(attr.value.value)) {
                handleAttributeNode(attr, replacements);
            }
        }
    }

    if (node.children) {
        for (const child of node.children) {
            traverseTemplate(child, replacements);
        }
    }
}

function handleTextNode(node, replacements) {
    const trimmedText = node.value.trim();
    if (trimmedText && !trimmedText.startsWith('{{') && !trimmedText.includes('$t(\'_')) {
        replacedTexts.add(trimmedText);
        const wrappedText = `{{ $t('_.${trimmedText}') }}`;
        replacements.push({ start: node.range[0], end: node.range[1], text: wrappedText });
    }
}

function handleAttributeNode(node, replacements) {
    const trimmedText = node.value.value.trim();
    if (trimmedText && !trimmedText.startsWith('$t(\'_')) {
        replacedTexts.add(trimmedText);
        const wrappedText = `:${node.key.name}="$t('_.${trimmedText}')"`;
        replacements.push({ start: node.range[0], end: node.range[1], text: wrappedText });
    }
}

function singleFileProcessor(filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const fileExt = path.extname(filePath);

    if (fileExt === '.js' || fileExt === '.jsx') {
        const processedContent = processJavaScript(fileContent, true);
        return {
            inputFileContent: processedContent,
            modifyFile: () => fs.writeFileSync(filePath, processedContent),
            filePath,
        };
    } else if (fileExt === '.vue') {
        const { ast } = readTemplate(filePath);
        let processedContent = fileContent;

        // 处理 template
        if (ast.templateBody) {
            const replacements = [];
            traverseTemplate(ast.templateBody, replacements);
            replacements.sort((a, b) => b.start - a.start);
            for (const { start, end, text } of replacements) {
                processedContent = processedContent.slice(0, start) + text + processedContent.slice(end);
            }
        }

        // 处理 script 和 script setup
        const scriptMatch = processedContent.match(/<script(\s+setup)?[^>]*>([\s\S]*?)<\/script>/i);
        if (scriptMatch) {
            const scriptContent = scriptMatch[2];
            const processedScript = processJavaScript(scriptContent, true);
            if (processedScript !== scriptContent) {
                processedContent = processedContent.replace(scriptMatch[0], `<script${scriptMatch[1] || ''}>
${processedScript}
</script>`);
            }
        }

        return {
            inputFileContent: processedContent,
            modifyFile: () => fs.writeFileSync(filePath, processedContent),
            filePath,
        };
    }
}

async function generateLocaleFile() {
   // 获取用户执行命令时的当前工作目录
   const currentWorkingDirectory = process.cwd();
    
   // 定义生成文件的目录
   const outputDirectory = path.join(currentWorkingDirectory, 'locales-generated');
   
   // 检查并创建目录（如果不在）
   if (!fs.existsSync(outputDirectory)) {
       fs.mkdirSync(outputDirectory, { recursive: true });
   }
   

    const outputFilePath = path.join(outputDirectory, 'zh-CN-common.js');
    const existingTexts = {};

    if (fs.existsSync(outputFilePath)) {
        const fileContent = fs.readFileSync(outputFilePath, 'utf-8');
        const matches = fileContent.match(/'([^']+)':\s*'([^']+)'/g);
        if (matches) {
            for (const match of matches) {
                const [key, value] = match.split(':').map(part => part.trim().replace(/^'|'$/g, ''));
                existingTexts[key] = value;
            }
        }
    }

    const replacedTextsObj = {};
    for (const text of replacedTexts) {
        if (!text.startsWith('_') && !existingTexts.hasOwnProperty(text)) {
            replacedTextsObj[text] = text;
        }
    }
    const allTexts = { ...existingTexts, ...replacedTextsObj };
    const outputStream = fs.createWriteStream(outputFilePath);
    outputStream.write('/* eslint-disable prettier/prettier */\nexport default {\n');
    for (const text in allTexts) {
        if (!text.startsWith('_')) {
            const escapedKey = escapeForTranslation(text);
            const escapedValue = escapeForTranslation(allTexts[text]);
            outputStream.write(`  '${escapedKey}': '${escapedValue}',\n`);
        }
    }
    outputStream.end('};\n');

    // 在文件生成完成后，返回生成的文件路径
    return outputFilePath;
}

function generateTxtFile() {
        const outputFilePath = path.join(__dirname, 'zh-CN-common.txt');
    let existingTexts = [];
    const txtSet = new Set();
    if (fs.existsSync(outputFilePath)) {
        const fileContent = fs.readFileSync(outputFilePath, 'utf-8');
        existingTexts = fileContent.split('\n');
    }
    existingTexts.forEach((item) => {
        txtSet.add(item);
    });

    for (const item of replacedTexts) {
        txtSet.add(item);
    }

    const outputStream = fs.createWriteStream(outputFilePath);
    // Write all texts to the file
    for (const text of replacedTexts) {
        outputStream.write(`${text}\n`);
    }
    outputStream.end('\n');
}

async function applyInDir(filePath, dirPath, excludedDirList, extractTxt) {
    // console.log('dirPath', dirPath, excludedDirList);
    const files = glob.sync(path.join(dirPath, '**/*.{vue,js,jsx}').replace(/\\/g, '/'), {
        ignore: excludedDirList,
    });
    console.log('Total files:', files.length);
    if (filePath) {
        files.push(filePath);
    }

    let processedCount = 0;
    const errorLog = [];

    for (let i = 0; i < files.length; i++) {
        const dfilePath = files[i];
        console.log(`Processing file ${i + 1}/${files.length}: ${dfilePath}`);
        try {
            const p = singleFileProcessor(dfilePath);
            if (!extractTxt) p.modifyFile();
            processedCount++;

            // 显示进度
            const progress = ((processedCount / files.length) * 100).toFixed(2);
            console.log(`Progress: ${progress}% (${processedCount}/${files.length})`);
        } catch (error) {
            console.error(`Error processing file ${dfilePath}:`, error);
            errorLog.push({ file: dfilePath, error: error.message });
        }
    }

    if (extractTxt) {
        generateTxtFile();
    } else {
        await generateLocaleFile();
    }

    console.log(`Processing completed. ${processedCount} files processed.`);
    if (errorLog.length > 0) {
        console.log(`Errors occurred in ${errorLog.length} files.`);
    }
}

async function translateLocaleFile() {
    dotenv.config();
    const apiKey = process.env.API_KEY;
    const apiUrl = process.env.API_URL;
    const localesDir = path.join(process.cwd(), '/locales-generated')
    if (!apiKey || !apiUrl) {
        console.error('API key or URL not set. Please run "fes-locale-gen config set --key <your-key> --url <your-url>" first.');
        return;
    }

    const openai = new OpenAI({
        apiKey: apiKey,
        baseURL: apiUrl,
    });
    
    const zhFilePath = path.join(localesDir, 'zh-CN-common.js');
    const enFilePath = path.join(localesDir, 'en-US-common.js');

    if (!fs.existsSync(zhFilePath)) {
        console.error(`zh-CN-common.js not found in ${localesDir}. Please generate it first.`);
        return;
    }

    // 读取文件内容并替换 export default 为 module.exports =
    let zhContent = fs.readFileSync(zhFilePath, 'utf-8');
    zhContent = zhContent.replace('export default', 'module.exports =');
    
    // 将修改后的内容写入临时文件
    const tempFilePath = path.join(localesDir, 'temp-zh-CN-common.js');
    fs.writeFileSync(tempFilePath, zhContent);

    // 使用 require 导入对象
    const zhJson = require(tempFilePath);

    // 删除临时文件
    fs.unlinkSync(tempFilePath);

    const chunks = chunkObject(zhJson, 200);

    let translatedContent = {};
    for (let i = 0; i < chunks.length; i++) {
        console.log(`Translating chunk ${i + 1} of ${chunks.length}...`);
        const translatedChunk = await translateChunk(chunks[i], openai);
        if (translatedChunk) {
            translatedContent = { ...translatedContent, ...JSON.parse(translatedChunk) };
        } else {
            console.error(`Failed to translate chunk ${i + 1}.`);
        }
    }

    const outputContent = `/* eslint-disable prettier/prettier */\nexport default ${JSON.stringify(translatedContent, null, 2)};\n`;
    fs.writeFileSync(enFilePath, outputContent);
    console.log('Translation completed. en-US-common.js has been generated.');
}

function checkConfig() {
    dotenv.config();
    const apiKey = process.env.API_KEY;
    const apiUrl = process.env.API_URL;

    if (!apiKey || !apiUrl) {
        console.error('API key or URL not set. Please run "fes-locale-gen config set --key <your-key> --url <your-url>" first.');
        process.exit(1);
    }
}

async function main() {
    applyInDir(args.f, args.d, args.e, false);
}

// 配置命令
function handleConfig() {
    if (args._[1] === 'list') {
        // 列出当前配置
        dotenv.config();
        console.log('Current configuration:');
        console.log(`API_KEY: ${process.env.API_KEY || 'Not set'}`);
        console.log(`API_URL: ${process.env.API_URL || 'Not set'}`);
    } else if (args._[1] === 'set') {
        // 设置新配置
        const config = {};
        if (args.key) config.API_KEY = args.key;
        if (args.url) config.API_URL = args.url;
        
        const envContent = Object.entries(config)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        fs.writeFileSync('.env', envContent);
        console.log('Configuration saved successfully.');
    } else {
        console.log('Please use either "list" or "set" subcommand with "config" command.');
    }
}

// 翻译命令
async function handleTranslate() {
    checkConfig();
    await translateLocaleFile();
}

// 主逻辑
if (args._[0] === 'config') {
    handleConfig();
} else if (args._[0] === 'translate') {
    handleTranslate();
} else {
    main();
}

// 分组函数
function chunkObject(obj, size) {
    const chunks = [];
    const entries = Object.entries(obj);
    for (let i = 0; i < entries.length; i += size) {
        chunks.push(Object.fromEntries(entries.slice(i, i + size)));
    }
    return chunks;
}

// 翻译函数
async function translateChunk(chunk, openai) {
    const prompt = `Translate the following JSON object values from Chinese to English. Keep the keys unchanged:\n${JSON.stringify(chunk)}`;
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            response_format: {type: "json_object"}
        });
        const translatedText = response.choices[0].message.content;
        return translatedText;
    } catch (error) {
        console.error('Translation error:', error.message);
        return null;
    }
}
