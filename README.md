# FES 国际化自动脚本工具

## 功能
1. 读取指定目录下的所有.vue、.js、.jsx文件，自动替换template与script中的语言标签为变量引用形式。以中文作为key，提高代码可读性。
例：
```
<!-- 转换前： -->
<h1 label="排序">组织架构管理</h1>

<!-- 转换后： -->
<h1 :label="$t('_.排序')">{{ $t('_.组织架构管理') }}</h1>
```

2. 会在命令执行的目录下生成locales-generated/zh-CN-common.js

3. 支持将生成的中文文件翻译成英文（en-US-common.js）
## 用法

### 安装

```
npm i -g fes-locale-gen
```

### 基本使用
```
fes-locale-gen -d <目录> -e <排除文件>
```

### 配置翻译API
```
fes-locale-gen config set --key <your-api-key> --url <api-url>
```

### 查看当前配置
```
fes-locale-gen config list
```

### 翻译生成的中文文件
```
fes-locale-gen translate
```

### 注意事项
脚本将完成80%的重复性文本替换工作，剩余部分需要人工处理并同时做好替换后的核对。

**注意以下是脚本执行后需要手动完成的部分:**

~~1. 需要为每个文件手动添加i18n插件的引入语句。~~

`/pages/**.vue`
```
import { useI18n } from '@fesjs/fes';
const { t: $t } = useI18n();
```

2. 配置好fes-i18n插件并引入准备好的翻译配置文件：

`/locales/en-US.js`
```
/**  
 * 1. 引入自动生成的翻译配置 
 * （将生成的翻译配置放在其他目录的原因，locales目录会影响导航栏中语言切换选项的展示）
 * */
import enUSCommon from './locales-generated/en-US-common';

export default {
    /**  2. 使用下划线作为自动生成的命名空间 */
    _: enUSCommon,

    /**  3. 手动添加或主动覆盖的翻译配置 */
    首页: 'Front Page',
    产品管理: 'Product Management',
    天: 'Day',
    周: 'Week',
    月: 'Month',
};
```

3. 手动配置页面标题与菜单的翻译

4. 脚本执行前做好git版本管理，脚本执行后做好生成结果检查

## 暂未覆盖的场景
- template中的表达式，如`<p>{{ row.compare === 1 ? '是' : '否' }}</p>`
- 指令中的插值，例如
```
:label="`${variable}`""
:rules="[
    {
        validator: (rule, value) => {
            return true
        },
        trigger: ['blur', 'change'],
        message: `${test}工作流名称需以字母开头，允许字母、数字、下划线，不超过 128 字符`
    }
]"
```
