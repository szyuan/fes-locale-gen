import { defineComponent, inject, ref, watch } from 'vue';
import type { NodeType } from '../types/flow';
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
        
        return () => (
            <div name="测试1">
                
            </div>
        );
    },
});
