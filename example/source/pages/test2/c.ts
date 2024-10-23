import { defineComponent } from 'vue'


defineComponent({
    setup: (props)=> {
        const bb = `c测试`
        const ee = '测试e'
        const dd = `${bb?`${bb}aa测试`:'测试3'}`
      return {
        a:'测试'
      }  
    }
})