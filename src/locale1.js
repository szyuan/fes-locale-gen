#!/usr/bin/env node
const fs = require('fs');
const { parse } = require('vue-eslint-parser');
const path = require('path');
const glob = require('glob');
const minimist = require('minimist');
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

function singleFileProcessor(filePath) {
    const replacements = [];
    let { inputFileContent, ast } = readTemplate(filePath);
    traverse(ast.templateBody);
    // Sort the replacements in reverse order
    replacements.sort((a, b) => b.start - a.start);
    // Apply the replacements
    for (const { start, end, text } of replacements) {
        inputFileContent = inputFileContent.slice(0, start) + text + inputFileContent.slice(end);
    }

    function traverse(node) {
        if (node.type === 'VText' && /[\u4e00-\u9fa5]/.test(node.value)) {
            // Handle text nodes as before
            handleTextNode(node);
        } else if (node.startTag && node.startTag.attributes) {
            // For each attribute in the start tag
            for (const attr of node.startTag.attributes) {
                if (attr.value && /[\u4e00-\u9fa5]/.test(attr.value.value)) {
                    // Handle attribute nodes
                    handleAttributeNode(attr);
                }
            }
        }

        if (node.children) {
            for (const child of node.children) {
                traverse(child, node);
            }
        }
    }

    function handleTextNode(node) {
        // Save leading and trailing whitespace
        const leadingWhitespace = node.value.match(/^\s*/)[0];
        const trailingWhitespace = node.value.match(/\s*$/)[0];

        // Trim the text before translation
        const trimmedText = node.value.trim();

        // Add the trimmed text to the replacedTexts array
        replacedTexts.add(trimmedText);

        // Wrap the text with "{{ t('...') }}"
        const wrappedText = `{{ t('_.${trimmedText}') }}`;

        const start = node.range[0];
        const end = node.range[1];
        // Add the replacement to the list, with the original whitespace
        replacements.push({ start, end, text: leadingWhitespace + wrappedText + trailingWhitespace });
    }

    function handleAttributeNode(node) {
        // Trim the text before translation
        const trimmedText = node.value.value.trim();

        // Add the trimmed text to the replacedTexts array
        replacedTexts.add(trimmedText);

        // Wrap the text with "t('...')"
        const wrappedText = `:${node.key.name}="t('_.${trimmedText}')"`;

        const start = node.range[0];
        const end = node.range[1];
        // Add the replacement to the list
        replacements.push({ start, end, text: wrappedText });
    }

    function modifyVueFile() {
        fs.writeFileSync(filePath, inputFileContent);
    }

    return {
        inputFileContent,
        modifyVueFile,
        filePath,
    };
}

function generateLocaleFile() {
    const outputFilePath = path.join(__dirname, 'zh-CN-common.js');
    const existingTexts = {};
    if (fs.existsSync(outputFilePath)) {
        const fileContent = fs.readFileSync(outputFilePath, 'utf-8');
        const matches = fileContent.match(/'([^']+)': '([^']+)'/g);
        if (matches) {
            for (const match of matches) {
                const [key, value] = match.replace(/'/g, '').split(': ');
                existingTexts[key.trim()] = value.trim();
            }
        }
    }

    // Convert replacedTexts Set to an object
    const replacedTextsObj = {};
    for (const text of replacedTexts) {
        replacedTextsObj[text] = text;
    }
    // Merge existingTexts and replacedTextsObj
    const allTexts = { ...existingTexts, ...replacedTextsObj };
    const outputStream = fs.createWriteStream(outputFilePath);
    outputStream.write('/* eslint-disable prettier/prettier */\nexport default {\n');
    // Write all texts to the file
    for (const text in allTexts) {
        outputStream.write(`  '${text}': '${text}',\n`);
    }
    outputStream.end('};\n');
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
    const vueFiles = glob.sync(path.join(dirPath, '**/*.vue'), {
        ignore: excludedDirList,
    });
    if (filePath) {
        vueFiles.push(filePath);
    }
    // console.log(vueFiles);
    // readTemplate
    vueFiles.forEach((dfilePath) => {
        console.log('filePath: ', dfilePath);
        const p = singleFileProcessor(dfilePath);
        if (!extractTxt) p.modifyVueFile();
    });
}

function applyInFile(filePath, extractTxt) {
    const dfilePath = filePath;
    console.log('filePath: ', dfilePath);
    const p = singleFileProcessor(dfilePath);
    if (!extractTxt) p.modifyVueFile();
    if (extractTxt) {
        generateTxtFile();
    } else {
        generateLocaleFile();
    }
}

function main() {
    // applyInDir(null, '../../../src/components/Message');
    applyInDir(args.f, args.d, args.e, true);
    // applyInFile('../../../src/components/Message.vue');
}

main();
