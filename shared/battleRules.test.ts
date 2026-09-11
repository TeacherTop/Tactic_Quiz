import {expect,it} from 'vitest'
import {numericDuel} from './battleRules'
it.each([
  [42,42,42,true,null], [41,43,42,true,null], [40,44,42,true,null],
  [null,null,42,true,null], [null,43,42,false,'defender'], [42,null,42,false,'attacker'],
  [40,41,42,false,'defender'], [42,41,42,false,'attacker'],
] as const)('shared duel decision %s vs %s', (a,d,answer,replay,winner) => {
 expect(numericDuel(a,d,answer)).toMatchObject({replay,winner})
})
