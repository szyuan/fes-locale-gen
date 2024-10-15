/**  
 * 1. 引入自动生成的翻译配置 
 * （将生成的翻译配置放在其他目录的原因，locales目录会影响导航栏中语言切换选项的展示）
 * */
import zhCNCommon from '../common/locales/zh-CN-common';

export default {
    /**  2. 使用下划线作为自动生成的命名空间 */
    _: zhCNCommon,

    /**  3. 手动添加或主动覆盖的翻译配置 */
    首页: '首页',
    产品管理: '产品管理',
    人员管理: '人员管理',
    天: '天',
    周: '周',
    月: '月',
};
