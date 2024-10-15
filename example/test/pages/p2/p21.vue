<template>
    <div class="page">
        <div class="page-content mx-6">
            <h1 class="page-title">组织架构管理</h1>
            <div class="main">
                <div class="flex">
                    <div class="w-sm bg-red flex-shrink-0 mr-2">
                        <div class="text-base font-bold mb-4">组织架构</div>
                        <div class="space-x-2">
                            <FButton type="primary" :disabled="selectedNode && selectedNode.level >= 5" @click="onOrgModifyClick('ADD')">
                                <PlusOutlined />新增
                            </FButton>
                            <FButton @click="onOrgModifyClick('EDIT')"><EditOutlined />编辑</FButton>
                        </div>
                    </div>
                    <div class="flex-grow">
                        <div class="text-base font-bold mb-4">组织信息</div>
                        <div class="table-wrapper mt-4">
                            <FTable bordered size="small" :data="orgTableData" rowKey="name">
                                <FTableColumn v-slot="{ row }" label="是否参与排名">{{ row.compare === 1 ? '是' : '否' }}</FTableColumn>
                                <FTableColumn prop="indexNo" label="排序"></FTableColumn>
                            </FTable>
                        </div>
                        <div class="text-base font-bold my-4">人员信息</div>
                        <div class="table-wrapper mt-4">
                            <FTable bordered size="small" :data="tableData" rowKey="aaa">
                                <FTableColumn v-slot="{ rowIndex }" label="序号" :width="50">{{ rowIndex + 1 }}</FTableColumn>
                                <FTableColumn prop="name" label="员工姓名"></FTableColumn>
                                <FTableColumn prop="roleNames" label="角色"></FTableColumn>
                            </FTable>
                        </div>
                        <div class="pagination-wrapper">
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
import { FTable, FTableColumn, FButton, FMessage } from '@fesjs/fes-design';
import { computed, ref } from 'vue';
import { useI18n } from '@fesjs/fes';
import { queryOrgTree } from '@/common/api/common';
import { formatOrgTree } from '@/common/service';
import { queryPropsFactory } from '@/pages/agent-market/service';

const { t } = useI18n();


const orgTreeData = ref([]);

function updateOrgTree() {
    queryOrgTree().then((result) => {
        const orgList = result.catalogList;
        orgTreeData.value = formatOrgTree(orgList);
    });
}

const tableData = ref([]);

// ---- 组织操作 ------------------------------------------
const selectedNode = ref(null);

const orgTableData = computed(() => {
    let data = [];
    if (selectedNode.value) {
        data = [selectedNode.value];
    }
    return data;
});

// 新增 --------------------------
const orgModifyFormConfig = {
    name: {
        rules: {
            required: true,
            label: '组织名称',
            message: '组织名称不能为空',
        },
        default: '',
    },
    indexNo: {
        rules: {
            required: true,
            label: '排序序号',
            min: 1,
            max: 100,
            type: 'number',
            message: '请输入1-100的整数',
        },
        default: 1,
    },
    compare: {
        rules: {
            required: true,
            label: '是否参与排名',
            type: 'integer',
        },
        default: 1,
    },
    parentId: null,
    id: null,
    classify: 'ORG',
};

function onOrgModifyClick(flag) {
    if (flag === 'EDIT') {
        if (!selectedNode.value) return FMessage.error('请先选择节点');
    }
}


// 生命周期 ------------------------------------------------
updateOrgTree();
</script>

<config>
{
    "name": "org-manage",
    "title": "$组织架构"
}
</config>
