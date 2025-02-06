import AuthProvider from 'https://ebs.sugoidogo.com/SugoiAuthProvider.mjs'
import { ApiClient } from 'https://cdn.jsdelivr.net/npm/@twurple/api@7/+esm'
import WebStorage from 'https://ebs.sugoidogo.com/WebStorage.mjs'
import { Polly } from 'https://tts.sugoidogo.com/twitch-polly.mjs'
import { EventSubWsListener } from 'https://cdn.jsdelivr.net/npm/@twurple/eventsub-ws@7/+esm'
import dracula_flow from 'https://sugoidogo.github.io/dracula_flow/dracula_flow.mjs'

const client_id = '1gsnqnvtrguxysilfqp5gkb1snswmf'

/** @type {import('./node_modules/twitch-cloud-ebs/static/SugoiAuthProvider.mjs').default} */
const authProvider = new AuthProvider(client_id)
/** @type {import('@twurple/api').ApiClient} */
const apiClient = new ApiClient({ authProvider })
/** @type {import('@twurple/eventsub-ws').EventSubWsListener} */
const eventSub=new EventSubWsListener({ apiClient })
/** @type {import('./node_modules/twitch-cloud-ebs/static/WebStorage.mjs').default} */
const webStorage = new WebStorage(authProvider)
/** @type {import('./node_modules/cloudflare-polly-proxy/static/twitch-polly.mjs').Polly} */
const polly = new Polly(authProvider)

const params=new URLSearchParams(location.hash.substring(1)+location.search)
const id=params.get('id')
const config=await webStorage.fetch('v2/'+id).then(response=>response.json())

console.debug(config)

const audio=document.querySelector('audio')
const loadingUI=document.querySelector('h1')
const img_active=document.getElementById('active')
const img_idle=document.getElementById('idle')

img_active.src=config.img_active
img_idle.src=config.img_idle

if(config.img_active){
    audio.addEventListener('play',()=>img_active.style.opacity=1)
    audio.addEventListener('pause',()=>img_active.style.opacity=0)
    if(config.img_idle){
        audio.addEventListener('play',()=>img_idle.style.opacity=0)
        audio.addEventListener('pause',()=>img_idle.style.opacity=1)
        img_idle.style.opacity=1
    }
}else{
    img_idle.style.opacity=1
}

loadingUI.style.opacity=0

const broadcaster_id = await apiClient.getTokenInfo().then(info => info.userId)

const editors=[]
apiClient.channels.getChannelEditors(broadcaster_id).then(users=>users.forEach(user=>editors.push(user.userId)))

const moderators=[]
apiClient.moderation.getModeratorsPaginated(broadcaster_id).getAll().then(users=>users.forEach(user=>moderators.push(user.userId)))
eventSub.onChannelModeratorAdd(broadcaster_id,event=>moderators.push(event.userId))
eventSub.onChannelModeratorRemove(broadcaster_id,event=>moderators.splice(moderators.indexOf(event.userId),1))

const vips=[]
apiClient.channels.getVipsPaginated(broadcaster_id).getAll().then(users=>users.forEach(user=>vips.push(user.userId)))
eventSub.onChannelVipAdd(broadcaster_id,event=>vips.push(event.userId))
eventSub.onChannelVipRemove(broadcaster_id,event=>vips.splice(vips.indexOf(event.userId),1))

/**
 * @typedef {Object} TTSRequest
 * @property {String} [messageId]
 * @property {String} [redeemId]
 * @property {String} [input]
 * @property {String} [audio_url]
 * @property {String} [userId]
 */

/** @type {Array<TTSRequest>} */
const queue=[]
/** @type {TTSRequest} */
let nowPlaying=null

if(config.trigger==='chat' || config.trigger==='points'){
    eventSub.onChannelChatMessageDelete(broadcaster_id,broadcaster_id,event=>{
        if(nowPlaying && nowPlaying.messageId===event.messageId){
            return audio.pause()
        }
        for(const i in queue){
            if(queue[i].messageId===event.messageId){
                return queue.splice(i,1)
            }
        }
    })
}

/**
 * 
 * @param {TTSRequest} ttsRequest 
 */
async function queueTTS(ttsRequest){
    while(!config.allowAll){
        if(config.allowEditors && editors.includes(ttsRequest.userId)){
            break
        }
        if(config.allowMods && moderators.includes(ttsRequest.userId)){
            break
        }
        if(config.allowVIPs && vips.includes(ttsRequest.userId)){
            break
        }
        if(config.allowUsers && config.allowedUsers.includes(ttsRequest.userId)){
            break
        }
        if(ttsRequest.redeemId){
            apiClient.channelPoints.updateRedemptionStatusByIds(broadcaster_id,id,[ttsRequest.redeemId],'CANCELED')
        }
        return
    }
    let text=null
    switch(config.type){
        case 'preset':{
            text=config.presetText
            break
        }
        case 'dracula':{
            text=await dracula_flow(1)
            break
        }
        case 'input':{
            text=ttsRequest.input
            break
        }
        default:throw new Error('unknown tts type: '+config.type)
    }
    const request=await polly.SynthesizeSpeech(text,config.voice,'ssml',config.engine)
    if(!request.ok){
        const error=await request.text()
        if(ttsRequest.messageId){
            apiClient.chat.sendChatMessage(broadcaster_id,error,{replyParentMessageId:ttsRequest.messageId})
        }
        if(ttsRequest.redeemId){
            apiClient.channelPoints.updateRedemptionStatusByIds(broadcaster_id,id,[ttsRequest.redeemId],'CANCELED')
        }
        return false
    }
    const audio_blob=await request.blob()
    const audio_url=URL.createObjectURL(audio_blob)
    ttsRequest.audio_url=audio_url
    if(!nowPlaying){
        nowPlaying=ttsRequest
        audio.src=audio_url
        await audio.play()
        return true
    }
    queue.push(ttsRequest)
    return true
}

audio.onpause=()=>{
    nowPlaying=queue.shift()
    if(!nowPlaying){
        return
    }
    audio.src=nowPlaying.audio_url
    audio.play()
}

if(config.trigger==='chat'){
    const listener=eventSub.onChannelChatMessage(broadcaster_id,broadcaster_id,async event=>{
        if(event.messageText.startsWith(config.command)){
            const input=event.messageText.substring(config.command.length)
            await queueTTS({input,messageId:event.messageId,userId:event.chatterId})
            if(config.cooldown>0){
                listener.stop()
                setTimeout(()=>listener.start(),config.cooldown*1000)
            }
        }
    })
}

if(config.trigger==='points'){

    /** @type {Array<TTSRequest>} */
    const rewardMessageQueue=[]

    eventSub.onChannelRedemptionAddForReward(broadcaster_id,id,async event=>{
        if(!event.input){
            queueTTS({redeemId:event.id,userId:event.userId})
        }
        for(const i in rewardMessageQueue){
            if(rewardMessageQueue[i].redeemId || !rewardMessageQueue[i].messageId){
                continue
            }
            if(rewardMessageQueue[i].input===event.input && rewardMessageQueue[i].userId===event.userId){
                rewardMessageQueue[i].redeemId=event.id
                queueTTS(rewardMessageQueue[i])
                rewardMessageQueue.splice(i,1)
                return
            }
        }
        rewardMessageQueue.push({input:event.input,redeemId:event.id,userId:event.userId})
    })

    eventSub.onChannelChatMessage(broadcaster_id,broadcaster_id,async event=>{
        if(event.rewardId!==id){
            return
        }
        for(const i in rewardMessageQueue){
            if(rewardMessageQueue[i].messageId || !rewardMessageQueue[i].redeemId){
                continue
            }
            if(rewardMessageQueue[i].input===event.messageText && rewardMessageQueue[i].userId===event.chatterId){
                rewardMessageQueue[i].messageId=event.id
                queueTTS(rewardMessageQueue[i])
                rewardMessageQueue.splice(i,1)
                return
            }
        }
        rewardMessageQueue.push({input:event.messageText,messageId:event.messageId,userId:event.chatterId})
    })

    eventSub.onChannelRedemptionUpdateForReward(broadcaster_id,id,event=>{
        if(event.status!=='canceled'){
            return
        }
        if(nowPlaying && nowPlaying.redeemId===event.id){
            audio.pause()
        }
        for(const i in queue){
            if(queue[i].redeemId!==event.id){
                continue
            }
            queue.splice(i,1)
            return
        }
        for(const i in rewardMessageQueue){
            if(rewardMessageQueue[i].redeemId!==event.id){
                continue
            }
            rewardMessageQueue.splice(i,1)
            return
        }
    })
}

eventSub.start()