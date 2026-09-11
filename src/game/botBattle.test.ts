vi.mock('@twa-dev/sdk', () => ({default:{}}))
import {expect,it,vi} from 'vitest'
import {reducer} from '../App'
import {defaultBotSettings} from './botSettings'
it.each([[42, 42], [41, 43]])('replays a tied numeric duel (%i, %i) in bot mode', (attackerAnswer, defenderAnswer) => {
 let state = reducer({phase:'home',match:null,completedRoundResult:null},{type:'start',settings:defaultBotSettings([]),questions:[{id:'test',prompt:'Test',options:['a','b','c','d'],correctIndex:0}]})
 const match = state.match!
 match.attacker = 'you'; match.defender = 'alex'; match.target = {row:1,col:0,owner:'alex'}
 match.numericQuestion = {id:'n1',prompt:'One',answer:42}
 match.numericQuestions = [{id:'n1',prompt:'One',answer:42},{id:'n2',prompt:'Two',answer:50}]
 match.numericAnswers = {you:attackerAnswer,alex:defenderAnswer,marina:null}
 state = reducer({...state,phase:'battle-number'},{type:'finish-number'})
 expect(state.phase).toBe('battle-number')
 expect(state.match?.numericQuestion.id).toBe('n2')
 expect(state.match?.numericAnswers).toEqual({you:null,alex:null,marina:null})
 expect(state.match?.battleRound).toBe(match.battleRound)
 expect(state.match?.arena).toEqual(match.arena)
 const bonus = attackerAnswer === 42 ? 5 : 0
 expect(state.match?.scores.you).toBe(match.scores.you + bonus)
 expect(state.match?.scores.alex).toBe(match.scores.alex + bonus)
})

it.each([1,2] as const)('finishes the bot match with %i opponents using regular captures and battle animations', opponents => {
 let state = reducer({phase:'home',match:null,completedRoundResult:null},{type:'start',settings:{...defaultBotSettings([]),opponents,arenaSize:7},questions:[{id:'test',prompt:'Test',options:['a','b','c','d'],correctIndex:0}]})
 for(let step=0;state.phase !== 'results' && step<200;step++) {
  const m=state.match!
  switch(state.phase) {
   case 'expansion':
    for(const id of m.playerIds) state=reducer(state,{type:'answer-expansion',id,pick:m.expansionQuestion.correctIndex,answeredAt:step})
    state=reducer(state,{type:'finish-expansion'});break
   case 'expansion-review': state=reducer(state,{type:'finish-expansion-review'});break
   case 'expansion-between': state=reducer(state,{type:'finish-expansion-between'});break
   case 'expansion-capture': {
    if(m.pendingCapture) {
     const {getAvailableCells}=arenaHelpers
     const [row,col]=[...getAvailableCells(m.arena,m.pendingCapture)][0].split(':').map(Number)
     state=reducer(state,{type:'capture-expansion',row,col})
    }
    state=reducer(state,{type:'finish-expansion-review'});break
   }
   case 'battle-select': {
    const target=arenaHelpers.getAttackTargets(m.arena,m.attacker)[0]
    state=reducer(state,{type:'select-attack',row:target.row,col:target.col})
    expect(state.phase).toBe('battle-approach');break
   }
   case 'battle-approach': state=reducer(state,{type:'finish-battle-approach'});break
   case 'battle-warmup':
    state=reducer(state,{type:'answer-warmup',id:m.attacker,pick:(m.warmupQuestion.correctIndex+1)%4})
    state=reducer(state,{type:'answer-warmup',id:m.defender!,pick:m.warmupQuestion.correctIndex})
    expect(state.phase).toBe('battle-result');break
   case 'battle-result': state=reducer(state,{type:'finish-battle-result'});break
   default: throw new Error(`Unexpected phase ${state.phase}`)
  }
 }
 expect(state.phase).toBe('results')
 expect(state.match?.battleRound).toBe(opponents===1?8:9)
 expect(state.match?.arena.every(cell=>cell.owner)).toBe(true)
})
import * as arenaHelpers from './arena'
