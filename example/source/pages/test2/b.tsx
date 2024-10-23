import { defineComponent, inject, ref, watch } from 'vue';

import type { Ref } from 'vue';

export default defineComponent({
    name: 'GenericNode',
    props: {
        node: {
            type: Object,
            required: true,
        },
    },
    setup(props, { attrs }) {
        const aa = '测试2'
        const bb = aa? `${aa?'测试4':'bb'}`: '测试3'
        return () => (
            <div name="测试1">
                
            </div>
        );
    },
});
