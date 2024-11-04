<template>
    <div name="测试1">{{aa ? '测试4': '测试5'}}测试2</div>
</template>

<script setup>

const aa = '测试3'
const bb = aa ? '测试4': '测试\n5'


</script>

