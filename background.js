// =============================================
// background.js - 后台服务脚本（Service Worker）
// 在 Manifest V3 中，后台脚本以 Service Worker 形式运行
// 核心功能：主密码管理、AES-256-GCM 加密/解密、密码存储、消息路由
//
// ========== 加密体系说明 ==========
// 1. 主密码通过 SHA-256 哈希后存储，原始主密码不落盘
// 2. 每条密码记录使用 AES-256-GCM 加密，密钥由 PBKDF2 派生
// 3. PBKDF2 使用 100000 次迭代 + 随机盐，有效抵御暴力破解
// 4. 每条记录的盐和 IV 独立随机生成，确保安全性
//
// ========== 重要安全提示 ==========
// - 主密码无法找回，忘记主密码则加密数据将永久丢失且无法恢复
// - 主密码应设置得足够复杂（建议 8 位以上，包含大小写字母、数字和特殊字符）
// - 缓存机制仅在 Service Worker 内存中保留 5 分钟，重启后自动清空
// =============================================

console.log('[密码管理器-后台] background.js Service Worker 已启动');

// =============================================
// 常量定义
// =============================================
const STORAGE_KEY = 'passwords';                    // chrome.storage.local 中密码数组的键名
const MASTER_HASH_KEY = 'masterPasswordHash';       // 主密码哈希的存储键名
const PBKDF2_ITERATIONS = 100000;                   // PBKDF2 迭代次数，越高越安全但越慢
const CACHE_DURATION_MS = 5 * 60 * 1000;            // 主密码缓存时长：5 分钟

// 主密码内存缓存（Service Worker 重启后自动清空，不会持久化）
let cachedMasterPassword = null;
let cacheTimestamp = 0;

// =============================================
// Service Worker 保活机制
// MV3 的 Service Worker 会在 30 秒无活动后被终止
// 通过 chrome.alarms API 定期唤醒，保持活跃
// =============================================
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === 'keepAlive') {
        // 此 alarm 的唯一目的就是防止 Service Worker 被系统终止
    }
});

// =============================================
// 加密工具函数（基于 Web Crypto API）
// =============================================

/**
 * ArrayBuffer → Base64 字符串
 * 将二进制数据编码为可存储/传输的 Base64 格式
 */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Base64 字符串 → ArrayBuffer
 * 将 Base64 编码的数据解码为二进制格式
 */
function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * SHA-256 哈希函数
 * 用于主密码的单向哈希存储，不可逆
 */
async function sha256Hash(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return arrayBufferToBase64(hashBuffer);
}

/**
 * PBKDF2 密钥派生函数
 * 从主密码派生 AES-256 密钥，使用随机盐和 100000 次迭代
 * 即使两条记录使用相同主密码，由于盐不同，派生出的密钥也不同
 */
async function deriveAesKey(masterPassword, salt) {
    const encoder = new TextEncoder();
    // 第一步：将主密码导入为 PBKDF2 原始密钥材料
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(masterPassword),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    // 第二步：使用 PBKDF2 派生 AES-GCM 256 位密钥
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * AES-GCM 加密函数
 * 加密流程：
 * 1. 生成 16 字节随机盐（salt）→ 确保每条记录的密钥唯一
 * 2. 生成 12 字节随机 IV（初始化向量）→ 确保每次加密结果不同
 * 3. 通过 PBKDF2 从主密码+盐派生 AES-256 密钥
 * 4. 使用 AES-GCM 模式加密明文
 * 5. 将 salt + iv + ciphertext 合并后 Base64 编码存储
 *
 * 存储格式（Base64）：[16字节盐][12字节IV][N字节密文]
 */
async function encryptPassword(plainPassword, masterPassword) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(masterPassword, salt);
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encoder.encode(plainPassword)
    );
    // 合并 salt + iv + ciphertext 为单一 buffer
    const ciphertextArray = new Uint8Array(ciphertext);
    const combined = new Uint8Array(salt.length + iv.length + ciphertextArray.length);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(ciphertextArray, salt.length + iv.length);
    return arrayBufferToBase64(combined.buffer);
}

/**
 * AES-GCM 解密函数
 * 解密流程：
 * 1. Base64 解码得到 combined buffer
 * 2. 拆分出 salt（前16字节）、iv（接下来12字节）、ciphertext（剩余部分）
 * 3. 通过 PBKDF2 从主密码+盐派生 AES-256 密钥
 * 4. 使用 AES-GCM 解密得到明文
 *
 * 如果主密码错误或数据被篡改，crypto.subtle.decrypt 会抛出异常
 */
async function decryptPassword(encryptedBase64, masterPassword) {
    const combined = new Uint8Array(base64ToArrayBuffer(encryptedBase64));
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const ciphertext = combined.slice(28);
    const key = await deriveAesKey(masterPassword, salt);
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        ciphertext
    );
    return new TextDecoder().decode(decrypted);
}

// =============================================
// 缓存管理
// =============================================

/**
 * 检查主密码缓存是否仍然有效
 * 缓存有效期为 CACHE_DURATION_MS（5 分钟）
 * Service Worker 重启后缓存自动清空
 */
function isCacheValid() {
    return cachedMasterPassword && (Date.now() - cacheTimestamp < CACHE_DURATION_MS);
}

// =============================================
// 旧数据迁移加密
// 在用户首次设置或验证主密码后，将历史明文记录加密
// =============================================

/**
 * 迁移未加密的历史记录
 * 遍历所有密码记录，将 isEncrypted !== true 的记录用主密码加密
 * 迁移后的记录标记 isEncrypted: true
 */
async function migrateUnencryptedRecords(masterPassword) {
    try {
        const result = await chrome.storage.local.get([STORAGE_KEY]);
        const passwords = result[STORAGE_KEY] || [];
        let migratedCount = 0;

        for (let i = 0; i < passwords.length; i++) {
            if (!passwords[i].isEncrypted) {
                // 该记录尚未加密，使用主密码加密 password 字段
                passwords[i].password = await encryptPassword(passwords[i].password, masterPassword);
                passwords[i].isEncrypted = true;
                migratedCount++;
            }
        }

        if (migratedCount > 0) {
            await chrome.storage.local.set({ [STORAGE_KEY]: passwords });
            console.log('[密码管理器-后台] 迁移完成，共加密', migratedCount, '条历史记录');
        } else {
            console.log('[密码管理器-后台] 无需迁移，所有记录均已加密');
        }
    } catch (err) {
        console.error('[密码管理器-后台] 迁移过程出错：', err.message);
    }
}

// =============================================
// 消息路由（统一入口）
// 所有消息通过 handleMessage 异步处理后返回结果
// =============================================
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    console.log('[密码管理器-后台] 收到消息，类型：', message.type);
    console.log('[密码管理器-后台] 消息来源：', sender.tab ? sender.tab.url : 'popup');

    handleMessage(message, sender)
        .then(sendResponse)
        .catch(function (err) {
            console.error('[密码管理器-后台] 处理出错：', err.message);
            sendResponse({ success: false, error: err.message });
        });

    // 返回 true 表示此消息处理是异步的，保持消息通道开放直到 sendResponse 被调用
    return true;
});

// =============================================
// 消息处理路由函数
// 根据 message.type 分发到对应的处理器
// =============================================
async function handleMessage(message, sender) {
    switch (message.type) {
        // ---------- 主密码相关 ----------
        case 'IS_MASTER_PASSWORD_SET':
            return handleIsMasterPasswordSet();
        case 'SET_MASTER_PASSWORD':
            return handleSetMasterPassword(message);
        case 'VERIFY_MASTER_PASSWORD':
            return handleVerifyMasterPassword(message);
        case 'CHANGE_MASTER_PASSWORD':
            return handleChangeMasterPassword(message);
        case 'LOCK':
            return handleLock();

        // ---------- 密码记录 CRUD ----------
        case 'SAVE_LOGIN':
            return handleSaveLogin(message, sender);
        case 'GET_PASSWORDS':
            return handleGetPasswords();
        case 'DELETE_PASSWORD':
            return handleDeletePassword(message);
        case 'CLEAR_ALL_PASSWORDS':
            return handleClearAllPasswords();
        case 'UPDATE_NOTES':
            return handleUpdateNotes(message);

        default:
            console.warn('[密码管理器-后台] 未知消息类型：', message.type);
            return { success: false, error: '未知消息类型：' + message.type };
    }
}

// =============================================
// IS_MASTER_PASSWORD_SET - 检查主密码是否已设置
// =============================================
async function handleIsMasterPasswordSet() {
    const result = await chrome.storage.local.get([MASTER_HASH_KEY]);
    const isSet = !!result[MASTER_HASH_KEY];
    console.log('[密码管理器-后台] 主密码是否已设置：', isSet);
    return { isSet: isSet };
}

// =============================================
// SET_MASTER_PASSWORD - 设置主密码（首次设置）
// 流程：校验 → 哈希存储 → 缓存 → 迁移旧数据
// =============================================
async function handleSetMasterPassword(message) {
    const { password } = message;

    // 安全校验
    if (!password || password.trim().length === 0) {
        return { success: false, error: '主密码不能为空' };
    }
    if (password.length < 6) {
        return { success: false, error: '主密码长度至少为 6 位' };
    }

    // 检查是否已设置过主密码（防止重复设置，应使用 CHANGE_MASTER_PASSWORD 修改）
    const existing = await chrome.storage.local.get([MASTER_HASH_KEY]);
    if (existing[MASTER_HASH_KEY]) {
        return { success: false, error: '主密码已设置，请使用修改功能' };
    }

    // 计算 SHA-256 哈希并存储（不存储原始密码）
    const hash = await sha256Hash(password);
    await chrome.storage.local.set({ [MASTER_HASH_KEY]: hash });

    // 缓存主密码到内存，后续加解密操作无需再次输入
    cachedMasterPassword = password;
    cacheTimestamp = Date.now();

    // 迁移旧的未加密记录
    await migrateUnencryptedRecords(password);

    console.log('[密码管理器-后台] 主密码设置成功');
    return { success: true };
}

// =============================================
// VERIFY_MASTER_PASSWORD - 验证主密码
// 流程：计算哈希 → 与存储的哈希比对 → 匹配则缓存
// =============================================
async function handleVerifyMasterPassword(message) {
    const { password } = message;

    if (!password) {
        return { success: false, error: '请输入主密码' };
    }

    // 读取存储的哈希值
    const result = await chrome.storage.local.get([MASTER_HASH_KEY]);
    const storedHash = result[MASTER_HASH_KEY];

    if (!storedHash) {
        return { success: false, error: '尚未设置主密码' };
    }

    // 计算输入密码的哈希并与存储值比对
    const inputHash = await sha256Hash(password);
    if (inputHash !== storedHash) {
        console.log('[密码管理器-后台] 主密码验证失败');
        return { success: false, error: '主密码错误' };
    }

    // 验证成功，缓存主密码
    cachedMasterPassword = password;
    cacheTimestamp = Date.now();

    // 尝试迁移可能遗漏的未加密记录
    await migrateUnencryptedRecords(password);

    console.log('[密码管理器-后台] 主密码验证成功');
    return { success: true };
}

// =============================================
// CHANGE_MASTER_PASSWORD - 修改主密码
// 流程：验证旧密码 → 校验新密码 → 用旧密码解密所有记录 → 用新密码重新加密 → 更新哈希和缓存
// =============================================
async function handleChangeMasterPassword(message) {
    const { oldPassword, newPassword } = message;

    // 校验输入
    if (!oldPassword || !newPassword) {
        return { success: false, error: '请输入旧密码和新密码' };
    }
    if (newPassword.length < 6) {
        return { success: false, error: '新密码长度至少为 6 位' };
    }

    // 验证旧密码
    const result = await chrome.storage.local.get([MASTER_HASH_KEY]);
    const storedHash = result[MASTER_HASH_KEY];
    if (!storedHash) {
        return { success: false, error: '尚未设置主密码' };
    }
    const oldHash = await sha256Hash(oldPassword);
    if (oldHash !== storedHash) {
        return { success: false, error: '旧密码错误' };
    }

    // 读取所有密码记录
    const data = await chrome.storage.local.get([STORAGE_KEY]);
    const passwords = data[STORAGE_KEY] || [];

    // 用旧密码解密每条记录，再用新密码重新加密
    for (let i = 0; i < passwords.length; i++) {
        if (passwords[i].isEncrypted) {
            try {
                // 用旧密码解密得到明文
                const plainText = await decryptPassword(passwords[i].password, oldPassword);
                // 用新密码重新加密
                passwords[i].password = await encryptPassword(plainText, newPassword);
            } catch (err) {
                console.error('[密码管理器-后台] 第', i, '条记录重加密失败：', err.message);
                return { success: false, error: '密码重加密失败，部分记录可能无法恢复，请确认旧密码正确' };
            }
        }
    }

    // 保存更新后的记录
    await chrome.storage.local.set({ [STORAGE_KEY]: passwords });

    // 更新主密码哈希
    const newHash = await sha256Hash(newPassword);
    await chrome.storage.local.set({ [MASTER_HASH_KEY]: newHash });

    // 更新缓存
    cachedMasterPassword = newPassword;
    cacheTimestamp = Date.now();

    console.log('[密码管理器-后台] 主密码修改成功，共重加密', passwords.length, '条记录');
    return { success: true };
}

// =============================================
// SAVE_LOGIN - 保存登录信息
// 流程：校验 → 加密（如有主密码缓存）→ 去重存储 → 通知
// =============================================
async function handleSaveLogin(message, sender) {
    const { url, domain, username, password, notes } = message;

    // 验证必要字段
    if (!url || !username || !password) {
        return { success: false, error: '缺少必要字段' };
    }

    // 读取已有密码数组
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const passwords = result[STORAGE_KEY] || [];

    // 根据主密码缓存状态决定是否加密
    let storedPassword = password;
    let encrypted = false;

    if (isCacheValid()) {
        // 主密码已缓存且有效，加密后存储
        storedPassword = await encryptPassword(password, cachedMasterPassword);
        encrypted = true;
        console.log('[密码管理器-后台] 密码已加密存储');
    } else {
        // 主密码未缓存，直接存储明文（后续验证主密码时会自动迁移加密）
        console.log('[密码管理器-后台] 主密码未缓存，密码以明文存储');
    }

    // 按域名 + 用户名去重
    const existingIndex = passwords.findIndex(function (item) {
        const existingDomain = extractDomain(item.url);
        const newDomain = extractDomain(url);
        return existingDomain === newDomain && item.username === username;
    });

    let action = '';

    if (existingIndex !== -1) {
        // 已存在 → 更新密码和备注
        passwords[existingIndex].password = storedPassword;
        passwords[existingIndex].isEncrypted = encrypted;
        if (notes !== undefined) {
            passwords[existingIndex].notes = notes;
        }
        passwords[existingIndex].updatedAt = new Date().toISOString();
        action = 'updated';
    } else {
        // 不存在 → 追加新记录
        passwords.push({
            url: url,
            username: username,
            password: storedPassword,
            notes: notes || '',
            isEncrypted: encrypted,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        action = 'created';
    }

    // 保存到 storage
    await chrome.storage.local.set({ [STORAGE_KEY]: passwords });
    console.log('[密码管理器-后台] 数据已保存，当前共', passwords.length, '条记录，操作：', action);

    // 发送系统通知
    sendNotification(username, domain || extractDomain(url), action);

    return { success: true, action: action };
}

// =============================================
// GET_PASSWORDS - 获取所有密码记录（解密后返回）
// 流程：检查缓存 → 读取记录 → 逐条解密 → 返回明文
// =============================================
async function handleGetPasswords() {
    // 检查主密码缓存是否有效
    if (!isCacheValid()) {
        return { success: false, error: '请先验证主密码' };
    }

    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const passwords = result[STORAGE_KEY] || [];

    // 逐条解密密码字段
    const decryptedPasswords = [];
    for (let i = 0; i < passwords.length; i++) {
        const record = Object.assign({}, passwords[i]);
        if (record.isEncrypted) {
            try {
                record.password = await decryptPassword(record.password, cachedMasterPassword);
            } catch (err) {
                // 解密失败（可能主密码不匹配或数据损坏）
                console.error('[密码管理器-后台] 第', i, '条记录解密失败：', err.message);
                record.password = '[解密失败]';
            }
        }
        decryptedPasswords.push(record);
    }

    return { success: true, passwords: decryptedPasswords };
}

// =============================================
// DELETE_PASSWORD - 删除指定密码记录
// =============================================
async function handleDeletePassword(message) {
    const { index } = message;

    if (index === undefined || index === null) {
        return { success: false, error: '缺少索引参数' };
    }

    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const passwords = result[STORAGE_KEY] || [];

    if (index < 0 || index >= passwords.length) {
        return { success: false, error: '索引超出范围' };
    }

    passwords.splice(index, 1);
    await chrome.storage.local.set({ [STORAGE_KEY]: passwords });
    console.log('[密码管理器-后台] 已删除第', index, '条记录，剩余', passwords.length, '条');

    return { success: true };
}

// =============================================
// CLEAR_ALL_PASSWORDS - 清空所有密码记录
// =============================================
async function handleClearAllPasswords() {
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
    console.log('[密码管理器-后台] 已清空所有密码记录');
    return { success: true };
}

// =============================================
// UPDATE_NOTES - 更新指定记录的备注
// =============================================
async function handleUpdateNotes(message) {
    const { index, notes } = message;

    if (index === undefined || index === null) {
        return { success: false, error: '缺少索引参数' };
    }

    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const passwords = result[STORAGE_KEY] || [];

    if (index < 0 || index >= passwords.length) {
        return { success: false, error: '索引超出范围' };
    }

    passwords[index].notes = notes || '';
    passwords[index].updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [STORAGE_KEY]: passwords });
    console.log('[密码管理器-后台] 已更新第', index, '条记录的备注');

    return { success: true };
}

// =============================================
// LOCK - 锁定（清空主密码缓存）
// 锁定后需要重新验证主密码才能查看密码
// =============================================
async function handleLock() {
    cachedMasterPassword = null;
    cacheTimestamp = 0;
    console.log('[密码管理器-后台] 已锁定，主密码缓存已清除');
    return { success: true };
}

// =============================================
// URL 域名提取工具
// 从完整 URL 中提取域名（去除 www. 前缀）
// =============================================
function extractDomain(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace(/^www\./, '');
    } catch (e) {
        return url;
    }
}

// =============================================
// 发送系统通知
// 使用 chrome.notifications API 发送桌面通知
// =============================================
function sendNotification(username, domain, action) {
    let title, message;

    if (action === 'updated') {
        title = '密码已更新';
        message = '已更新 [' + username + '] 在 ' + domain + ' 的密码';
    } else {
        title = '密码已保存';
        message = '已保存 [' + username + '] 在 ' + domain + ' 的密码';
    }

    console.log('[密码管理器-后台] 准备发送通知：', title, message);

    chrome.notifications.create('pwd-notification', {
        type: 'basic',
        title: title,
        message: message,
        priority: 1
    }, function (notificationId) {
        if (chrome.runtime.lastError) {
            console.error('[密码管理器-后台] 通知创建失败：', chrome.runtime.lastError.message);
        } else {
            console.log('[密码管理器-后台] 通知已发送，ID：', notificationId);
        }
    });
}

// =============================================
// Service Worker 生命周期事件
// =============================================
chrome.runtime.onInstalled.addListener(function (details) {
    console.log('[密码管理器-后台] onInstalled 事件，原因：', details.reason);

    if (details.reason === 'install') {
        // 首次安装时初始化存储
        chrome.storage.local.get([STORAGE_KEY], function (result) {
            if (!result[STORAGE_KEY]) {
                chrome.storage.local.set({ [STORAGE_KEY]: [] });
                console.log('[密码管理器-后台] 首次安装，已初始化密码存储');
            }
        });
    }
});

// Service Worker 激活时输出日志
console.log('[密码管理器-后台] Service Worker 初始化完成，等待消息...');
