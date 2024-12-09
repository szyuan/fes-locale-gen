#!/usr/bin/env node

// 清理 require 缓存
Object.keys(require.cache).forEach(function (key) { delete require.cache[key] });
const { parse: parseVue } = require("@vue/compiler-sfc")
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
const t = require('@babel/types');
const readline = require('readline');
const default_AI_PROMPT = 'Translate the following JSON object values from Chinese to English. Keep the keys unchanged'

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
            parser: '@typescript-eslint/parser', // 指定 TypeScript 解析器
            parserOptions: {
              ecmaVersion: 2020,
              sourceType: 'module',
              ecmaFeatures: {
                jsx: true,
                tsx: true, // 支持 TypeScript JSX
              },
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
    return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\0').replace(/\n/g, '\\0').replace(/\t/g, '\\t').replace(/\v/g, '\\v').replace(/\f/g, '\\f');
}

function processJavaScript(code, isModule = true, templateHasReplace = false, isJSFile = false) {
    try {
        let ast = parseJS(code, {
            sourceType: isModule ? 'module' : 'script',
            plugins: ['jsx', 'typescript'],
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
                if (path.node.callee.name === '$t' || 
                    (path.node.callee.type === 'MemberExpression' && 
                     path.node.callee.object.name === 'locale' && 
                     path.node.callee.property.name === 't')) {
                    path.skip();
                }
            },
            StringLiteral(path) {
                if (path.parent.type !== 'JSXAttribute' && /[\u4e00-\u9fa5]/.test(path.node.value) &&
                    !path.findParent(p => p.isCallExpression() && (p.node.callee.name === '$t' || (p.node.callee.type === 'MemberExpression' && p.node.callee.object.name === 'locale' && p.node.callee.property.name === 't'))) &&
                    !path.node.value.startsWith('_.$t(') &&
                    !path.node.value.match(/^\$t\('_\.[^']+'\)$/) &&
                    !path.node.value.match(/^locale\.t\('_\.[^']+'\)$/) &&
                    !path.findParent((p) => p.isCallExpression() && p.node.callee.type === 'MemberExpression' && p.node.callee.object.name === 'console')) {
                    const text = path.node.value;
                    const escapedText = escapeForTranslation(text);
                    replacedTexts.add(escapedText);
                    replacements.push({
                        start: path.node.start,
                        end: path.node.end,
                        text: `$t('_.${escapedText}')`
                    });
                }
            },
            // 处理标签属性中的中文字符
            JSXAttribute(path) {
                if (t.isJSXIdentifier(path.node.name) && t.isStringLiteral(path.node.value) && /[\u4e00-\u9fa5]/.test(path.node.value.value)) {
                    const trimmedText = path.node.value.value.trim();
                    if (trimmedText && !trimmedText.startsWith('$t(\'_')) {
                        const escapedText = escapeForTranslation(trimmedText);
                        replacedTexts.add(escapedText);
                        const wrappedText = `${path.node.name.name}={$t('_.${escapedText}')}`;
                        replacements.push({ start: path.node.start, end: path.node.end, text: wrappedText });
                    }
                }
            },
            // 处理标签内的中文字符
            JSXText(path) {
                if (/[\u4e00-\u9fa5]/.test(path.node.value) && !path.node.value.startsWith('$t(\'_') ) {
                    const text = path.node.value.trim();
                    const escapedText = escapeForTranslation(text);
                    replacedTexts.add(escapedText);
                    const wrappedText = '{`${' + `$t('_.${escapedText}')` + '}`}';
                    replacements.push({
                        start: path.node.start,
                        end: path.node.end,
                        text: wrappedText
                    });
                }
            },
            TemplateLiteral(path) {
                if (!path.findParent((p) => p.isCallExpression() && p.node.callee.type === 'MemberExpression' && p.node.callee.object.name === 'console')) {
                    path.node.quasis.forEach((quasi) => {
                        if (/[\u4e00-\u9fa5]/.test(quasi.value.raw) && 
                            !quasi.value.raw.includes('$t(\'_') &&
                            !quasi.value.raw.includes('locale.t(\'_') &&
                            !quasi.value.raw.match(/\$t\('_\.[^']+'\)/) &&
                            !quasi.value.raw.match(/locale\.t\('_\.[^']+'\)/)) {
                            const text = quasi.value.raw;
                            replacedTexts.add(text);
                            const escapedText = escapeForTranslation(text);
                            replacements.push({
                                start: quasi.start,
                                end: quasi.end,
                                text: `\${$t('_.${escapedText}')}`
                            });
                        }
                    });
                }
            }
        });

        // 应用替换
        replacements.sort((a, b) => b.start - a.start);
        for (const { start, end, text } of replacements) {
            code = code.slice(0, start) + text + code.slice(end);
        }

        // 如果有替换，进行第二次和第三次遍历
        if (replacements.length > 0 || templateHasReplace) {
            ast = parseJS(code, {
                sourceType: isModule ? 'module' : 'script',
                plugins: ['jsx', 'typescript'],
            });

            let hasLocaleImport = false;
            let existingFesImport = null;

            // 第二次遍历：检查是否引入 locale 或 useI18n
            traverse(ast, {
                ImportDeclaration(path) {
                    if (path.node.source.value === '@fesjs/fes') {
                        existingFesImport = path.node;
                        hasLocaleImport = path.node.specifiers.some(spec =>
                            spec.type === 'ImportSpecifier' &&
                            (spec.imported.name === 'locale' || spec.imported.name === 'useI18n'));
                    }
                }
            });

            // 添加 locale 或 useI18n 导入（如果需要）
            if (!hasLocaleImport) {
                if (existingFesImport) {
                    const importStart = existingFesImport.start;
                    const importEnd = existingFesImport.end;
                    const newImport = generate(existingFesImport).code.replace(/}(?=[^}]*$)/, isJSFile ? ', locale }' : ', useI18n }');
                    code = code.slice(0, importStart) + newImport + code.slice(importEnd);
                } else {
                    code = isJSFile
                        ? `import { locale } from '@fesjs/fes';\n` + code
                        : `import { useI18n } from '@fesjs/fes';\n` + code;
                }
            }

            // 只有在非 JS 文件的情况下才添加 $t 声明
            ast = parseJS(code, {
                sourceType: isModule ? 'module' : 'script',
                plugins: ['jsx', 'typescript'],
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

                        // 检查是否有 const $t = locale.t 的代码
                        if (
                            declaration.id.type === 'Identifier' &&
                            declaration.id.name === '$t' &&
                            declaration.init &&
                            declaration.init.type === 'MemberExpression' &&
                            declaration.init.object.name === 'locale' &&
                            declaration.init.property.name === 't'
                        ) {
                            hasDollarTDeclaration = true;
                        }

                        
                    });
                },
                
            });

            // 添加 $t 声明（如果需要）
            if (!hasDollarTDeclaration) {
                const lines = code.split('\n');
                const insertIndex = lastImportIndex !== -1 ? lastImportIndex + 1 : 0;
                const text = isJSFile? `\nconst $t = locale.t;\n`: `\nconst { t: $t } = useI18n();\n`
                lines.splice(insertIndex, 0, text);
                code = lines.join('\n');
            }
        }

        return code;
    } catch (error) {
        console.error('处理 JavaScript 时出错:', error);
        throw new Error(error)
        // return code;
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
    } else if (node.type === 'VExpressionContainer' && t.isConditionalExpression(node.expression)) {
        handleConditionExpression(node.expression, replacements);
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
        const escapedText = escapeForTranslation(trimmedText);
        replacedTexts.add(escapedText);
        const wrappedText = `{{ $t('_.${escapedText}') }}`;
        replacements.push({ start: node.range[0], end: node.range[1], text: wrappedText });
    }
}

function handleAttributeNode(node, replacements) {
    const trimmedText = node.value.value.trim();
    if (trimmedText && !trimmedText.startsWith('$t(\'_')) {
        const escapedText = escapeForTranslation(trimmedText);
        replacedTexts.add(escapedText);
        const wrappedText = `:${node.key.name}="$t('_.${escapedText}')"`;
        replacements.push({ start: node.range[0], end: node.range[1], text: wrappedText });
    }
}

function handleConditionExpression(node, replacements) {
    // 检查字符串是否包含中文
    const containsChinese = (str)=> {
        return /[\u4e00-\u9fa5]+/.test(str);
    }
    // 处理三元运算符
    if (containsChinese(node.consequent.value)) {
        const trimmedText = node.consequent.value.trim();
        if (trimmedText && !trimmedText.startsWith('$t(\'_')) {
            const escapedText = escapeForTranslation(trimmedText);
            replacedTexts.add(escapedText);
            const wrappedText = '`${' + `$t('_.${escapedText}')` + '}`';
            replacements.push({ start: node.consequent.range[0], end: node.consequent.range[1], text: `${wrappedText}` });
        }

    }
    if (containsChinese(node.alternate.value)) {
        const trimmedText = node.alternate.value.trim();
        if (trimmedText && !trimmedText.startsWith('$t(\'_')) {
            const escapedText = escapeForTranslation(trimmedText);
            replacedTexts.add(escapedText);
            const wrappedText = '`${' + `$t('_.${escapedText}')` + '}`';
            replacements.push({ start: node.alternate.range[0], end: node.alternate.range[1], text: `${wrappedText}` });
        }
    }

}

function singleFileProcessor(filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const fileExt = path.extname(filePath);

    if (fileExt === '.js' || fileExt === '.jsx' || fileExt === '.ts' || fileExt === '.tsx') {
        const processedContent = processJavaScript(fileContent, true, false, true);
        return {
            inputFileContent: processedContent,
            modifyFile: () => fs.writeFileSync(filePath, processedContent),
            filePath,
        };
    } else if (fileExt === '.vue') {
        const { ast } = readTemplate(filePath);
        let processedContent = fileContent;
        let templateHasReplace = false;
        // 处理 template
        if (ast.templateBody) {
            const replacements = [];
            traverseTemplate(ast.templateBody, replacements);
            // 处理template中变量
            const vueParseResult = parseVue(processedContent, {
                sourceType: 'module',
            });

            if (vueParseResult.descriptor.template && vueParseResult.descriptor.template.ast) {
                const templateAst = vueParseResult.descriptor.template.ast;
                processTemplateAst(templateAst, replacements);
            }
            replacements.sort((a, b) => b.start - a.start);
            for (const { start, end, text } of replacements) {
                processedContent = processedContent.slice(0, start) + text + processedContent.slice(end);
            }
            if (replacements.length > 0) {
                templateHasReplace = true;
            }
        }
        // 处理 script 和 script setup
        const scriptMatch = processedContent.match(/<script(\s+setup)?[^>]*>([\s\S]*?)<\/script>/i);
        if (scriptMatch) {
            const scriptContent = scriptMatch[2];
            const processedScript = processJavaScript(scriptContent, true, templateHasReplace, false);
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

function processTemplateAst(ast, replacements) {
    if (ast.props) {
        ast.props.forEach(prop => {
            if (prop.type === 7) { // 指令
                processDirective(prop, replacements);
            }
        });
    }

    if (ast.children) {
        ast.children.forEach(child => {
            content = processTemplateAst(child, replacements);
        });
    }
}

function processDirective(prop, replacements) {
    if (prop.exp && prop.exp.content && !prop.exp.content.includes('$t(')) {
        // 修改正则表达式，限制匹配范围
        const chineseRegex = /['"]([^'",\{\}\[\]]*[\u4e00-\u9fa5]+[^'",\{\}\[\]]*)['"]/g;
        let match;
        let processedContent = prop.exp.content;
        
        while ((match = chineseRegex.exec(prop.exp.content)) !== null) {
            const originalText = match[1];
            const escapedText = escapeForTranslation(originalText);
            if (!replacedTexts.has(escapedText)) {
                replacedTexts.add(escapedText);
            }
            processedContent = processedContent.replace(
                `'${originalText}'`,
                `$t('_.${escapedText}')`
            );
        }

        if (processedContent !== prop.exp.content) {
            replacements.push({start: prop.exp.loc.start.offset, end: prop.exp.loc.end.offset, text: processedContent})
        }
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
    let existingTexts = {};
    if (fs.existsSync(outputFilePath)) {
        // 读取文件内容并替换 export default 为 module.exports =
        let fileContent = fs.readFileSync(outputFilePath, 'utf-8');
        fileContent = fileContent.replace('export default', 'module.exports =');

        // 将修改后的内容写入临时文件
        const tempFilePath = path.join(outputDirectory, 'temp-zh-CN-common.js');
        fs.writeFileSync(tempFilePath, fileContent);

        // 使用 require 导入对象
        const zhJson = require(tempFilePath);

        // 删除临时文件
        fs.unlinkSync(tempFilePath);
        existingTexts = zhJson;
    }

    const replacedTextsObj = {};
    for (const text of replacedTexts) {
        if (!text.startsWith('_') && !existingTexts.hasOwnProperty(text)) {
            // 检查文本是否包含花括号
            if (text.includes('{') || text.includes('}')) {
                // 将花括号内的内容转换为模板字符串形式
                const processedText = text.replace(/\{([^}]+)\}/g, '${$1}');
                replacedTextsObj[text] = `{'${processedText}'}`;
            } else {
                replacedTextsObj[text] = text;
            }
        }
    }
    const outputStream = fs.createWriteStream(outputFilePath);
    outputStream.write('/* eslint-disable prettier/prettier */\nexport default {\n');
    for (const text in replacedTextsObj) {
        if (!text.startsWith('_') ) {
            // 如果值是以 {' 开头的，使用双引号包裹
            const value = replacedTextsObj[text];
            const quote = value.startsWith("{'") ? '"' : "'";
            outputStream.write(`  '${text}': ${quote}${value}${quote},\n`);
        }
    }
    for (const text in existingTexts) {
        if (!text.startsWith('_') && !replacedTextsObj.hasOwnProperty(escapeForTranslation(text))) {
            outputStream.write(`  '${escapeForTranslation(text)}': '${escapeForTranslation(existingTexts[text])}',\n`);
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
    const files = glob.sync(path.join(dirPath, '**/*.{vue,js,jsx,tsx,ts}').replace(/\\/g, '/'), {
        ignore: excludedDirList,
    });
    console.log('Total files:', files.length);
    if (filePath) {
        files.push(filePath);
    }

    let processedCount = 0;
    const errorLog = [];

    const currentTime = new Date().toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/[\s/:]/g, '');

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
            errorLog.push({
                file: dfilePath,
                error: error.message,
                stack: error.stack,
                // 错误记录时间也使用中国时区
                time: new Date().toLocaleString('zh-CN', { 
                    timeZone: 'Asia/Shanghai',
                    hour12: false 
                })
            });
        }
    }

    if (errorLog.length > 0) {
        const outputDirectory = path.join(process.cwd(), 'locales-generated');
        if (!fs.existsSync(outputDirectory)) {
            fs.mkdirSync(outputDirectory, { recursive: true });
        }

        const errorLogPath = path.join(outputDirectory, `errorlog-${currentTime}.json`);
        fs.writeFileSync(
            errorLogPath,
            JSON.stringify(
                {
                    summary: {
                        totalFiles: files.length,
                        processedFiles: processedCount,
                        errorCount: errorLog.length,
                        // 摘要时间也使用中国时区
                        timestamp: new Date().toLocaleString('zh-CN', { 
                            timeZone: 'Asia/Shanghai',
                            hour12: false 
                        })
                    },
                    errors: errorLog
                },
                null,
                2
            )
        );
        console.log(`Errors occurred in ${errorLog.length} files, you can check the error log in ${errorLogPath}`);
    }

    if (extractTxt) {
        generateTxtFile();
    } else {
        await generateLocaleFile();
    }

    console.log(`Processing completed. ${processedCount} files processed.`);
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

    // 读取已存在的英文翻译
    let existingTranslations = {};
    if (fs.existsSync(enFilePath)) {
        let enContent = fs.readFileSync(enFilePath, 'utf-8');
        enContent = enContent.replace('export default', 'module.exports =');
        const tempEnPath = path.join(localesDir, 'temp-en-US-common.js');
        fs.writeFileSync(tempEnPath, enContent);
        existingTranslations = require(tempEnPath);
        fs.unlinkSync(tempEnPath);
    }

    // 过滤出需要翻译的新内容
    const newTranslations = {};
    Object.keys(zhJson).forEach(key => {
        if (!existingTranslations[key]) {
            newTranslations[key] = zhJson[key];
        }
    });

    if (Object.keys(newTranslations).length === 0) {
        console.log('No new translations needed.');
        return;
    }

    console.log(`Translating ${Object.keys(newTranslations).length} new items...`);
    const chunks = chunkObject(newTranslations, 200);

    let translatedContent = { ...existingTranslations };
    for (let i = 0; i < chunks.length; i++) {
        console.log(`Translating chunk ${i + 1} of ${chunks.length}...`);
        const translatedChunk = await translateChunk(chunks[i], openai);
        if (translatedChunk) {
            const parsedChunk = JSON.parse(translatedChunk);
            Object.entries(parsedChunk).forEach(([key, value]) => {
                // 检查原始中文值是否使用了 {'xxx'} 格式
                const originalValue = zhJson[key];
                
                if (typeof originalValue === 'string' && originalValue.startsWith("{'") && originalValue.endsWith("'}")) {
                    // 如果原始值使用了 {'xxx'} 格式，翻译后的值也使用相同格式
                    translatedContent[key] = `{'${value}'}`;
                } else {
                    translatedContent[key] = value;
                }
            });
        } else {
            console.error(`Failed to translate chunk ${i + 1}.`);
        }
    }
    let missingKeys, extraKeys;
    let attempts = 0;
    const maxAttempts = 5;
    do {
        attempts++;
        console.log(`Attempt ${attempts} to resolve key mismatches...`);
        const zhKeys = Object.keys(zhJson);
        const enKeys = Object.keys(translatedContent);
        // 比对原始中文 JSON 和翻译后的英文 JSON
        missingKeys = zhKeys.filter(key => !enKeys.includes(key));
        extraKeys = enKeys.filter(key => !zhKeys.includes(key));

        if (missingKeys.length > 0) {
            console.log('Translating missing keys:', missingKeys);
            const missingChunk = {};
            missingKeys.forEach(key => {
                missingChunk[key] = zhJson[key];
            });

            const translatedMissingChunk = await translateChunk(missingChunk, openai);
            if (translatedMissingChunk) {
                const parsedMissingChunk = JSON.parse(translatedMissingChunk);
                translatedContent = { ...translatedContent, ...parsedMissingChunk };
            } else {
                console.error('Failed to translate missing keys');
                break;
            }
        }

        if (extraKeys.length > 0) {
            console.log('Removing extra keys:', extraKeys);
            extraKeys.forEach(key => {
                delete translatedContent[key];
            });
        }

        if (attempts >= maxAttempts) {
            console.error(`Reached maximum attempts (${maxAttempts}) to resolve key mismatches.`);
            break;
        }

    } while (missingKeys.length > 0 || extraKeys.length > 0);

    if (missingKeys.length > 0 || extraKeys.length > 0) {
        console.error('Translation mismatch detected after multiple attempts:');
        if (missingKeys.length > 0) {
            console.error('Missing keys in translated content:', missingKeys);
        }
        if (extraKeys.length > 0) {
            console.error('Extra keys in translated content:', extraKeys);
        }
        console.error('Please review and correct the translation manually.');
    } else {
        console.log('Translation completed successfully. All keys match.');
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

// 添加确认函数
async function confirmProcessAllFiles() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question('未指定目录(-d)，将处理当前目录下的所有文件，这可能需要较长时间并可能产生意外结果。是否继续？(y/N) ', (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y');
        });
    });
}

// 修改 main 函数
async function main() {
    // 如果没有指定目录且当前目录是默认值 './'
    if (!args.d || args.d === './') {
        const shouldContinue = await confirmProcessAllFiles();
        if (!shouldContinue) {
            console.log('操作已取消');
            process.exit(0);
        }
    }
    
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
        console.log(`AI_PROMPT: ${process.env.AI_PROMPT || 'Not set'}`);
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
    } else if (args._[1] === 'init') {
        // 设置新配置
        const config = {};
        config.API_KEY = ''
        config.API_URL = ''
        config.AI_PROMPT = default_AI_PROMPT
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
// 移除json关键字
function removeJsonKeyword(inputString) {
    // Check if the input string starts with "```json" and ends with "```"
    if (inputString.startsWith("```json") && inputString.endsWith("```")) {
        // Remove the "```json" from the start and "```" from the end
        return inputString.slice(7, -3).trim();
    }
    return inputString;
}
// 翻译函数
async function translateChunk(chunk, openai) {
    // 预处理数据，移除特殊格式
    const processedChunk = {};

    Object.entries(chunk).forEach(([key, value]) => {
        if (typeof value === 'string' && value.startsWith("{'") && value.endsWith("'}")) {
            // 移除 {'...'} 格式，保留实际内容
            processedChunk[key] = value.slice(2, -2);
        } else {
            processedChunk[key] = value;
        }
    });
    const prompt = `{
        Request: ${process.env.AI_PROMPT ? process.env.AI_PROMPT: default_AI_PROMPT},
        Restriction: "Only return the JSON object without any additional replies",
        Format: {
            "key": "value",
            ...
        },
        Original: ${JSON.stringify(processedChunk)},
        Response: {
            // your response here
            "key": "value"
            ...

        }
    }`
    try {
        const response = await openai.chat.completions.create({
            model: "qwen-72b",
            messages: [{ role: "user", content: prompt }],
            // response_format: { type: "json_object" }
        });
        const translatedText = removeJsonKeyword(response.choices[0].message.content);
        return translatedText;
    } catch (error) {
        console.error('Translation error:', error.message);
        return null;
    }
}

