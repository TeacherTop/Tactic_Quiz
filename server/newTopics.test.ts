import {afterEach,expect,it,vi} from 'vitest'
import {GameRoomStore} from './gameRoomStore'
afterEach(()=>vi.useRealTimers())
it.each(['География','Наука','Спорт','Философия','Цитаты'])('loads the new topic %s for a room', category=>{
 const store=new GameRoomStore()
 const {state:room}=store.createRoom({id:1,first_name:'Host'})
 store.joinRoom(room.roomCode,{id:2,first_name:'Guest'},'guest')
 store.updateSettings(room.roomId,room.hostPlayerId,{maxPlayers:2,arenaRadius:1,categories:[category]})
 store.startGame(room.roomId)
 expect(room.currentQuestion?.category).toBe(category)
})
it.each(['География','Наука','Спорт'])('uses numeric questions from the selected topic %s',category=>{
 vi.useFakeTimers()
 const store=new GameRoomStore()
 const {state:room}=store.createRoom({id:1,first_name:'Host'})
 const guest=store.joinRoom(room.roomCode,{id:2,first_name:'Guest'},'guest')
 store.updateSettings(room.roomId,room.hostPlayerId,{maxPlayers:2,arenaRadius:1,categories:[category]})
 store.startGame(room.roomId)
 room.arena=[{row:0,col:0,ownerId:room.hostPlayerId},{row:1,col:0,ownerId:guest.playerId}]
 room.phase='battle-select';room.activePlayerId=room.hostPlayerId
 store.chooseAttack(room.roomId,room.hostPlayerId,1,0)
 vi.setSystemTime(room.timerEndsAt!);store.advanceBattle(room.roomId)
 const correct=(store as unknown as {questionAnswers:Map<string,number>}).questionAnswers.get(room.roomId)!
 store.submitAnswer(room.roomId,room.hostPlayerId,correct)
 store.submitAnswer(room.roomId,guest.playerId,correct)
 vi.setSystemTime(room.timerEndsAt!);store.advanceBattle(room.roomId)
 expect(room.currentQuestion?.type).toBe('numeric')
 const prefixes:Record<string,string>={'География':'geo','Наука':'science','Спорт':'sport'}
 expect(room.currentQuestion?.id).toMatch(new RegExp(prefixes[category]))
})
