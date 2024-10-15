#!/usr/bin/env node
const fs = require('fs');
const { parse } = require('vue-eslint-parser');
const path = require('path');
const glob = require('glob');
const minimist = require('minimist');
const { parse: parseJS } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
// TODO简单翻译

// 解析命令行参数
const args = minimist(process.argv.slice(2), {
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

// 将排除的目录转为绝对路径
// args.e = args.e.map((e) => path.resolve(e));

// const filePath = process.argv[2] || '../../../src/pages/index.vue';
function readTemplate(filePath) {
    // const filePath = args.d;
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
        console.log('parse completed');
    } catch (e) {
        // console.warn('ast使用解析出错: ', filePath, e);
        console.error('ast解析出错: ', filePath, e);
    }
    return {
        inputFileContent,
        ast,
    };
}

// 总文本收集
const replacedTexts = new Set();

function processJavaScript(code, isModule = true) {
    try {
        const ast = parseJS(code, {
            sourceType: isModule ? 'module' : 'script',
            plugins: ['jsx'],
        });

        let hasUseI18nImport = false;
        let existingFesImport = null;
        const replacements = [];
        let lastImportIndex = -1;

        traverse(ast, {
            ImportDeclaration(path) {
                lastImportIndex = Math.max(lastImportIndex, path.node.end);
                if (path.node.source.value === '@fesjs/fes') {
                    existingFesImport = path.node;
                    hasUseI18nImport = path.node.specifiers.some(spec => 
                        spec.type === 'ImportSpecifier' && 
                        spec.imported.name === 'useI18n');
                }
            },
            CallExpression(path) {
                if (path.node.callee.type === 'MemberExpression' &&
                    path.node.callee.object.name === 'console') {
                    path.skip();
                }
            },
            StringLiteral(path) {
                if (/[\u4e00-\u9fa5]/.test(path.node.value) && 
                    !path.node.value.startsWith('_.$t(') &&
                    !path.findParent((p) => p.isCallExpression() && p.node.callee.type === 'MemberExpression' && p.node.callee.object.name === 'console')) {
                    const text = path.node.value;
                    replacedTexts.add(text);
                    replacements.push({
                        start: path.node.start,
                        end: path.node.end,
                        text: `$t('_.${text}')`
                    });
                }
            },
            TemplateLiteral(path) {
                if (!path.findParent((p) => p.isCallExpression() && p.node.callee.type === 'MemberExpression' && p.node.callee.object.name === 'console')) {
                    path.node.quasis.forEach((quasi) => {
                        if (/[\u4e00-\u9fa5]/.test(quasi.value.raw) && 
                            !quasi.value.raw.includes('$t(\'_')) {
                            const text = quasi.value.raw;
                            replacedTexts.add(text);
                            replacements.push({
                                start: quasi.start,
                                end: quasi.end,
                                text: `\${$t('_.${text}')}`
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

        // 如果需要导入 useI18n
        if (!hasUseI18nImport && replacements.length > 0) {
            let insertIndex = lastImportIndex + 1;
            if (existingFesImport) {
                // 修改现有的 @fesjs/fes 导入
                const importStart = existingFesImport.start;
                const importEnd = existingFesImport.end;
                const newImport = generate(existingFesImport).code.replace('}', ', useI18n }');
                code = code.slice(0, importStart) + newImport + code.slice(importEnd);
            } else {
                // 添加新的导入语句
                code = code.slice(0, insertIndex) + `\nimport { useI18n } from '@fesjs/fes';\n` + code.slice(insertIndex);
            }
        }

        return code;
    } catch (error) {
        console.error('Error in processJavaScript:', error);
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

    if (fileExt === '.js') {
        const chunkSize = 1000000; // 1MB chunks
        let processedContent = '';
        for (let i = 0; i < fileContent.length; i += chunkSize) {
            const chunk = fileContent.slice(i, i + chunkSize);
            processedContent += processJavaScript(chunk, true);
        }
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

function generateLocaleFile() {
    const outputFilePath = path.join(__dirname, 'zh-CN-common.js');
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

    // Convert replacedTexts Set to an object
    const replacedTextsObj = {};
    for (const text of replacedTexts) {
        if (!text.startsWith('_') && !existingTexts.hasOwnProperty(text)) {
            replacedTextsObj[text] = text;
        }
    }
    // Merge existingTexts and replacedTextsObj
    const allTexts = { ...existingTexts, ...replacedTextsObj };
    const outputStream = fs.createWriteStream(outputFilePath);
    outputStream.write('/* eslint-disable prettier/prettier */\nexport default {\n');
    // Write all texts to the file
    for (const text in allTexts) {
        if (!text.startsWith('_')) {
            const escapedKey = escapeString(text);
            const escapedValue = escapeString(allTexts[text]);
            outputStream.write(`  '${escapedKey}': '${escapedValue}',\n`);
        }
    }
    outputStream.end('};\n');
}

function escapeString(str) {
    return str
        .replace(/\\/g, '\\\\')  // 首先替换反斜杠
        .replace(/'/g, "\\'")    // 然后替换单引号
        .replace(/\n/g, '\\n')   // 替换换行符
        .replace(/\r/g, '\\r')   // 替换回车符
        .replace(/\t/g, '\\t');  // 替换制表符
}

// 只提取txt，不修改vue文件
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

function applyInDir(filePath, dirPath, excludedDirList, extractTxt) {
    console.log('dirPath', dirPath, excludedDirList);
    const files = glob.sync(path.join(dirPath, '**/*.{vue,js}').replace(/\\/g, '/'), {
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

            // 每处理10个文件，保存一次进度
            if (processedCount % 10 === 0) {
                saveProgress(processedCount, files.length);
            }
        } catch (error) {
            console.error(`Error processing file ${dfilePath}:`, error);
            errorLog.push({ file: dfilePath, error: error.message });
        }
    }

    if (extractTxt) {
        generateTxtFile();
    } else {
        generateLocaleFile();
    }

    // 保存最终进度和错误日志
    saveProgress(processedCount, files.length);
    saveErrorLog(errorLog);

    console.log(`Processing completed. ${processedCount} files processed.`);
    if (errorLog.length > 0) {
        console.log(`Errors occurred in ${errorLog.length} files. Check error_log.json for details.`);
    }
}

function saveProgress(processedCount, totalCount) {
    const progress = {
        processedCount,
        totalCount,
        timestamp: new Date().toISOString()
    };
    fs.writeFileSync('progress.json', JSON.stringify(progress, null, 2));
}

function saveErrorLog(errorLog) {
    fs.writeFileSync('error_log.json', JSON.stringify(errorLog, null, 2));
}

function main() {
    applyInDir(args.f, args.d, args.e, false);
}

main();