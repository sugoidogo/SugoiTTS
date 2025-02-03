const status_ui = document.getElementById('status_ui')
onerror = function (error) {
    status_ui.innerHTML = error.message
    //throw new Error(null,{cause:error})
}
onunhandledrejection = (event) => onerror(event.reason)

import AuthProvider from 'https://ebs.sugoidogo.com/SugoiAuthProvider.mjs'
import { ApiClient } from 'https://cdn.jsdelivr.net/npm/@twurple/api@7/+esm'
import WebStorage from 'https://ebs.sugoidogo.com/WebStorage.mjs'
import { Polly } from 'https://tts.sugoidogo.com/twitch-polly.mjs'

const client_id = '1gsnqnvtrguxysilfqp5gkb1snswmf'
const scopes = [
    'channel:read:editors',
    'channel:manage:moderators',
    'channel:read:redemptions',
    'channel:manage:redemptions',
    'channel:read:vips',
    'channel:manage:vips',
    'moderation:read',
    'user:read:chat',
    //'moderator:manage:automod',
]

status_ui.innerHTML = 'Connecting to Twitch...'
/** @type {import('./node_modules/twitch-cloud-ebs/static/SugoiAuthProvider.mjs').default} */
const authProvider = new AuthProvider(client_id)
await authProvider.addUser(...scopes)

/** @type {import('@twurple/api').ApiClient} */
const apiClient = new ApiClient({ authProvider })
/** @type {import('./node_modules/twitch-cloud-ebs/static/WebStorage.mjs').default} */
const webStorage = new WebStorage(authProvider)
/** @type {import('./node_modules/cloudflare-polly-proxy/static/twitch-polly.mjs').Polly} */
const polly = new Polly(authProvider)

const user_id = await apiClient.getTokenInfo().then(info => info.userId)
console.debug('userID: ' + user_id)

const template = document.querySelector('template').content.cloneNode(true)
const config_list = document.querySelector('#config_list')
const config_ui = document.querySelector('#config_ui')

status_ui.innerHTML = 'Loading voices...'
const voices = await polly.DescribeVoices()
const voicesByLanguageCode = {}
const voicesByID = {}
const lang = {}
/** @type {Set<String>} */
const engines = new Set()
for (const voice of voices) {
    voicesByID[voice.Id] = voice
    if (voicesByLanguageCode[voice.LanguageCode] === undefined) {
        voicesByLanguageCode[voice.LanguageCode] = {}
        lang[voice.LanguageCode] = voice.LanguageName
    }
    voicesByLanguageCode[voice.LanguageCode][voice.Name] = voice
    for (const engine of voice.SupportedEngines) {
        engines.add(engine)
    }
}
/** @type {HTMLSelectElement} */
const voicelist = template.querySelector('select[name=voice]')
for (const languageCode in voicesByLanguageCode) {
    const group = document.createElement('optgroup')
    group.label = lang[languageCode]
    for (const [name, voice] of Object.entries(voicesByLanguageCode[languageCode])) {
        const option = document.createElement('option')
        option.value = voice.Id
        option.innerHTML = name
        group.appendChild(option)
        if (name == 'Brian') {
            option.outerHTML = option.outerHTML.replace('<option', '<option selected')
        }
    }
    voicelist.appendChild(group)
}
/** @type {HTMLSelectElement} */
const enginelist = template.querySelector('select[name=engine]')
for (const engine of engines) {
    const option = document.createElement('option')
    option.value = engine
    option.innerHTML = engine
    enginelist.appendChild(option)
    if (engine == 'standard') {
        option.outerHTML = option.outerHTML.replace('<option', '<option selected')
    }
}

function onVoiceChange(voiceSelect) {
    if (voiceSelect instanceof Event) {
        voiceSelect = voiceSelect.target
    }
    /** @type {HTMLSelectElement} */
    const engineSelect = voiceSelect.form.querySelector('select[name=engine]')
    /** @type {Array<String>} */
    const supportedEngines = voicesByID[voiceSelect.value].SupportedEngines
    for (const option of engineSelect.children) {
        if (supportedEngines.includes(option.value)) {
            option.disabled = false
        } else {
            option.disabled = true
            if (engineSelect.value == option.value) {
                engineSelect.value = 'standard'
            }
        }
    }
}

function getConfig(form) {
    const formData = new FormData(form)
    const config = Object.fromEntries(formData)
    config.allowedUsers = formData.getAll('allowedUsers')
    return config
}

/**
 * 
 * @param {HTMLFormElement} form 
 * @param {*} config 
 */
async function applyConfig(form, addConfig) {
    const config = getConfig(form)
    Object.assign(config, addConfig)
    console.debug('loading config:', config)
    const allowedUsers = form.querySelector('table.users')
    for (const child of allowedUsers.children) {
        child.remove()
    }
    const allowAll=form.querySelector('[name=allowAll]')
    allowAll.outerHTML = allowAll.outerHTML.replace('checked', '')
    form.onreset = () => setTimeout(() => {
        applyConfig(form, config)
    }, 0)

    for (const [name, value] of Object.entries(config)) {
        if (value instanceof Array) {
            for (const userID of value) {
                const user = await apiClient.users.getUserById(userID)
                const row = newUserRow(user)
                allowedUsers.appendChild(row)
            }
        }
        const inputs = form.querySelectorAll('[name=' + name + ']')
        for (const input of inputs) {
            if (input instanceof HTMLInputElement) {
                switch (input.type) {
                    case 'checkbox':{
                        input.outerHTML = input.outerHTML.replace('<input', '<input checked')
                        break
                    }
                    case 'radio': {
                        if (input.value == value) {
                            input.outerHTML = input.outerHTML.replace('<input', '<input checked')
                        } else {
                            input.outerHTML = input.outerHTML.replace('checked', '')
                        }
                    }
                    default: {
                        input.defaultValue = value
                        break
                    }
                }
                continue
            }
            if (input instanceof HTMLSelectElement) {
                input.innerHTML = input.innerHTML.replaceAll('<option selected', '<option ')
                const option = input.querySelector('option[value=' + value + ']')
                if (!option) {
                    console.warn('incompatible config: ' + name + '=' + value)
                    continue
                }
                option.outerHTML = option.outerHTML.replace('<option', '<option selected')
                continue
            }
            if (input instanceof HTMLTextAreaElement) {
                input.innerHTML = value
                continue
            }
            if (input instanceof HTMLImageElement) {
                input.src=value || 'none.jpg'
                continue
            }
        }
    }
}

/** @param {SubmitEvent} event */
async function onSubmitConfig(event) {
    event.preventDefault()
    const form = event.target
    const config = getConfig(form)
    status_ui.innerHTML = 'checking for channel point reward...'
    let reward = await apiClient.channelPoints.getCustomRewardById(user_id, form.id)
    let warning_reward_disabled = false
    if (reward) {
        if (config.trigger !== 'points') {
            if (reward.isEnabled) {
                status_ui.innerHTML = 'disabling channel point reward...'
                reward = await apiClient.channelPoints.updateCustomReward(user_id, form.id, {
                    isEnabled: false
                })
            }
        } else {
            let cooldown = Number.parseInt(config.cooldown) || null
            switch (true) {
                case (reward.userInputRequired) && (config.type !== 'input'):
                case (!reward.userInputRequired) && (config.type === 'input'):
                case config.command !== reward.title:
                case cooldown !== reward.globalCooldown: {
                    status_ui.innerHTML = 'updating channel point reward...'
                    reward = await apiClient.channelPoints.updateCustomReward(user_id, form.id, {
                        title: config.command,
                        userInputRequired: config.type === 'input',
                        globalCooldown: cooldown
                    })
                    break
                }
                default: break
            }
            if (!reward.isEnabled) {
                warning_reward_disabled = true
            }
        }
    } else {
        if (config.trigger === 'points') {
            status_ui.innerHTML = 'creating channel point reward...'
            const cooldown = config.cooldown * 60
            reward = await apiClient.channelPoints.createCustomReward(user_id, {
                title: config.command,
                userInputRequired: config.type === 'input',
                cooldown: cooldown,
                isEnabled: false,
            })
            warning_reward_disabled = true
        }
    }
    console.debug('saving config:', config)
    status_ui.innerHTML = 'Saving settings...'
    const response = await webStorage.fetch('v2/' + form.id, {
        method: 'PUT',
        body: JSON.stringify(config)
    })
    if (!response.ok) {
        throw new Error(response.statusText, { cause: response })
    }
    applyConfig(form, config)
    status_ui.innerHTML = 'Copying URL to clipboard...'
    const url = new URL('tts.html', location)
    config.id = form.id
    const refresh_token = await authProvider.getAccessTokenForUser().then(token => token.refresh_token)
    url.search = new URLSearchParams({id:config.id,refresh_token}).toString()
    await navigator.clipboard.writeText(url.toString())
    let status = 'Settings saved, URL copied.'
    if (warning_reward_disabled) {
        status += ' Your channel point reward is disabled, enable it <a href="https://dashboard.twitch.tv/viewer-rewards/channel-points/rewards">here.</a>'
    }
    status_ui.innerHTML = status
}

function newUserRow(user) {
    const tableRow = document.createElement('tr')
    const tableDataUser = document.createElement('td')
    tableDataUser.className = 'username'
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = `allowedUsers`
    input.value = user.id
    tableDataUser.appendChild(input)
    tableDataUser.innerHTML += user.displayName
    tableRow.appendChild(tableDataUser)
    const tableDataRemove = document.createElement('td')
    const removeButton = document.createElement('button')
    removeButton.type = 'button'
    removeButton.innerHTML = 'remove'
    removeButton.onclick = () => { tableRow.remove(); status_ui.innerHTML = 'Removed ' + user.displayName }
    tableDataRemove.appendChild(removeButton)
    tableRow.appendChild(tableDataRemove)
    return tableRow
}

/** @param {SubmitEvent} event */
async function onSubmitUser(event) {
    event.preventDefault()
    /** @type {HTMLFormElement} */
    const form = event.target
    const username = new FormData(form).get('username')
    status_ui.innerHTML = 'Finding ' + username + "'s user id..."
    const user = await apiClient.users.getUserByName(username)
    if (!user) {
        status_ui.innerHTML = "Couldn't find " + username
        return
    }
    const tableRow = newUserRow(user)
    const userList = form.parentElement.parentElement.querySelector('table')
    userList.appendChild(tableRow)
    status_ui.innerHTML = 'Added ' + user.displayName
}

function addConfig(config = {}) {
    const fragment = template.cloneNode(true)
    /** @type {HTMLFormElement} */
    const form = fragment.querySelector('form')
    form.onsubmit = onSubmitConfig
    const addUserForm = form.querySelector('form')
    addUserForm.onsubmit = onSubmitUser
    form.id = config.id || Date.now()
    const voiceSelect = form.querySelector('select[name=voice]')
    voiceSelect.onchange = onVoiceChange
    const deleteButton = form.querySelector('button.delete')
    deleteButton.onclick = function () {
        form.className = 'delete'
        webStorage.fetch('v2/' + form.id, { method: 'DELETE' }).then(() => {
            form.outerHTML = ''
        })
    }
    const testButton = form.querySelector('button.test')
    testButton.onclick = async function () {
        status_ui.innerHTML = 'Loading TTS audio...'
        const config = Object.fromEntries(new FormData(form))
        /** @type {Response} */
        const response = await polly.SynthesizeSpeech(config.presetText, config.voice, 'ssml', config.engine)
        if (!response.ok) {
            throw new Error(response.statusText, { cause: response })
        }
        if (!response.headers.get('content-type').startsWith('audio')) {
            throw new Error(await response.text())
        }
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const audio = document.createElement('audio')
        audio.hidden = true
        audio.autoplay = true
        audio.src = url
        document.body.appendChild(audio)
        status_ui.innerHTML = 'Ready'
    }
    /** @type {NodeListOf<HTMLInputElement>} */
    const fileInputs = form.querySelectorAll('input[type=file]')
    const imgs = []
    for (const fileInput of fileInputs) {
        const input = fileInput.parentElement.querySelector('input.hidden')
        const img = fileInput.parentElement.querySelector('img')
        imgs.push(img)
        fileInput.onchange = async () => {
            status_ui.innerHTML = 'Loading image...'
            for (const file of fileInput.files) {
                const img_url = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result)
                    reader.onerror = error => reject(error)
                    reader.onabort = error => reject(error)
                    reader.readAsDataURL(file)
                });
                input.value = img_url
                img.src = img_url
            }
            status_ui.innerHTML = 'Loaded image'
            fileInput.value = ''
        }
        form.addEventListener('reset', () => setTimeout(() => img.src = input.value || 'none.jpg', 0))
    }
    try {
        applyConfig(form, config)
    } catch (error) {
        console.warn(error)
    }
    config_list.appendChild(form)
    onVoiceChange(voiceSelect)
    return form
}

status_ui.innerHTML = 'Loading settings...'
await webStorage.fetch('v2/').then(async response => {
    if (!response.ok) {
        throw new Error(null, { cause: response })
    }
    return response.json()
}).then(async configs => {
    console.debug('found ' + configs.length + ' configs for user')
    for (const id of configs) {
        const config = await webStorage.fetch('v2/' + id).then(response => response.json())
        config.id = id
        addConfig(config)
    }
}, error => console.warn(error))

status_ui.innerHTML = 'Loading managed channel point rewards...'
await apiClient.channelPoints.getCustomRewards(user_id, true).then(async function (rewards) {
    console.debug('found ' + rewards.length + ' channel point rewards for user')
    for (const reward of rewards) {
        const config = {
            id: reward.id,
            command: reward.title,
            trigger: 'points',
            cooldown: reward.globalCooldown || 0,
        }
        const form = document.getElementById(config.id)
        if (form) {
            const oldConfig=getConfig(form)
            if(oldConfig.trigger!=='points'){
                continue
            }
            applyConfig(form, config)
        } else {
            if (reward.userInputRequired) {
                config.type = 'input'
            }
            const oldConfig = await webStorage.fetch(config.id).then(response => {
                if (response.ok) {
                    return response.json()
                }
                return null
            })
            if (oldConfig) {
                status_ui.innerHTML = 'Importing v1 config for ' + reward.title + '...'
                Object.assign(config, oldConfig)
                config.id = reward.id
                if (config.neural) {
                    delete config.neural
                    config.engine = 'neural'
                }
            }
            addConfig(config)
        }
    }
})

document.querySelector('button.new').onclick = () => addConfig()

config_ui.hidden = false
status_ui.innerHTML = "Ready"