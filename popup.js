// =============================================
// popup.js - Edge 扩展弹出页面脚本
// 主密码加密体系 + 锁屏逻辑
// =============================================

// ---- 状态变量 ----
var isUnlocked = false;
var decryptedPasswords = [];
var currentEditIndex = -1;
var autoLockTimer = null;
var AUTO_LOCK_MS = 5 * 60 * 1000;
var lockMode = 'set';

// =============================================
// 消息发送工具函数
// =============================================
function sendMessage(message) {
    return new Promise(function(resolve, reject) {
        chrome.runtime.sendMessage(message, function(response) {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

function safeGetElement(id) {
    var el = document.getElementById(id);
    if (!el) {
        console.error('[密码管理器] 元素不存在：#' + id);
    }
    return el;
}

// =============================================
// HTML 转义
// =============================================
function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// =============================================
// 锁屏逻辑
// =============================================

async function initLockScreen() {
    try {
        var response = await sendMessage({ type: 'IS_MASTER_PASSWORD_SET' });

        var lockScreen = safeGetElement('lockScreen');
        var mainContainer = safeGetElement('mainContainer');

        if (!lockScreen || !mainContainer) return;

        lockScreen.style.display = 'flex';
        mainContainer.style.display = 'none';

        var lockTitle = safeGetElement('lockTitle');
        var lockDesc = safeGetElement('lockDesc');
        var masterPasswordConfirm = safeGetElement('masterPasswordConfirm');
        var btnUnlock = safeGetElement('btnUnlock');
        var lockError = safeGetElement('lockError');
        var lockWarning = document.querySelector('.lock-warning');

        if (!response.isSet) {
            lockMode = 'set';
            if (lockTitle) lockTitle.textContent = '设置主密码';
            if (lockDesc) lockDesc.textContent = '首次使用，请设置主密码来保护您的数据';
            if (masterPasswordConfirm) masterPasswordConfirm.style.display = 'block';
            if (btnUnlock) btnUnlock.textContent = '设置主密码';
            if (lockWarning) lockWarning.style.display = 'block';
        } else {
            lockMode = 'unlock';
            if (lockTitle) lockTitle.textContent = '解锁密码管理器';
            if (lockDesc) lockDesc.textContent = '请输入主密码以访问您的数据';
            if (masterPasswordConfirm) masterPasswordConfirm.style.display = 'none';
            if (btnUnlock) btnUnlock.textContent = '解锁';
            if (lockWarning) lockWarning.style.display = 'none';
        }

        if (lockError) lockError.style.display = 'none';

        var masterPasswordInput = safeGetElement('masterPasswordInput');
        if (masterPasswordInput) masterPasswordInput.value = '';
        if (masterPasswordConfirm) masterPasswordConfirm.value = '';
    } catch (e) {
        showLockError('初始化失败：' + e.message);
    }
}

async function handleUnlockClick() {
    var masterPasswordInput = safeGetElement('masterPasswordInput');
    if (!masterPasswordInput) return;
    var password = masterPasswordInput.value;

    if (lockMode === 'set') {
        var confirmInput = safeGetElement('masterPasswordConfirm');
        var confirmVal = confirmInput ? confirmInput.value : '';

        if (!password) {
            showLockError('请输入主密码');
            return;
        }
        if (password.length < 6) {
            showLockError('主密码长度至少 6 位');
            return;
        }
        if (password !== confirmVal) {
            showLockError('两次输入的密码不一致');
            return;
        }

        try {
            var response = await sendMessage({ type: 'SET_MASTER_PASSWORD', password: password });
            if (response.success) {
                isUnlocked = true;
                showMainUI();
            } else {
                showLockError(response.error || '设置失败');
            }
        } catch (e) {
            showLockError('设置失败：' + e.message);
        }
    } else {
        if (!password) {
            showLockError('请输入主密码');
            return;
        }

        try {
            var response = await sendMessage({ type: 'VERIFY_MASTER_PASSWORD', password: password });
            if (response.success) {
                isUnlocked = true;
                showMainUI();
            } else {
                showLockError(response.error || '密码错误');
                shakeLockScreen();
            }
        } catch (e) {
            showLockError('验证失败：' + e.message);
        }
    }
}

function showLockError(message) {
    var errorEl = safeGetElement('lockError');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.style.display = 'block';
}

function shakeLockScreen() {
    var lockScreen = safeGetElement('lockScreen');
    if (!lockScreen) return;
    lockScreen.style.animation = 'none';
    lockScreen.offsetHeight;
    lockScreen.style.animation = 'shake 0.4s ease';
}

function showMainUI() {
    var lockScreen = safeGetElement('lockScreen');
    var mainContainer = safeGetElement('mainContainer');

    if (lockScreen) lockScreen.style.display = 'none';
    if (mainContainer) mainContainer.style.display = 'flex';

    isUnlocked = true;
    loadAndRenderPasswords();
    fillCurrentTabUrl();
    resetAutoLockTimer();
}

// =============================================
// 密码加载（通过 GET_PASSWORDS 消息）
// =============================================
async function loadAndRenderPasswords() {
    try {
        var response = await sendMessage({ type: 'GET_PASSWORDS' });
        if (response.success) {
            decryptedPasswords = response.passwords;
            renderPasswords();
        } else {
            showToast('会话已过期，请重新输入主密码');
            lockApp();
        }
    } catch (e) {
        showToast('加载密码失败：' + e.message);
    }
}

// =============================================
// 渲染密码列表
// =============================================
function renderPasswords() {
    var accountList = safeGetElement('accountList');
    var stats = safeGetElement('stats');
    var accountCount = safeGetElement('accountCount');

    if (!accountList) return;

    if (decryptedPasswords.length === 0) {
        accountList.innerHTML =
            '<li class="empty-state">' +
                '<div class="icon">📭</div>' +
                '<p>还没有保存任何账号</p>' +
                '<p>手动添加或访问登录页面自动保存</p>' +
            '</li>';
        if (stats) stats.style.display = 'none';
        return;
    }

    if (stats) stats.style.display = 'flex';
    if (accountCount) accountCount.textContent = decryptedPasswords.length;

    var sortedPasswords = decryptedPasswords.slice().sort(function(a, b) {
        return new Date(b.createdAt) - new Date(a.createdAt);
    });

    var html = '';
    for (var displayIndex = 0; displayIndex < sortedPasswords.length; displayIndex++) {
        var item = sortedPasswords[displayIndex];
        var originalIndex = decryptedPasswords.indexOf(item);

        var date = new Date(item.createdAt);
        var dateStr = (date.getMonth() + 1) + '/' + date.getDate() + ' ' + date.getHours() + ':' + String(date.getMinutes()).padStart(2, '0');

        var displayUrl = item.url;
        try {
            var urlObj = new URL(item.url);
            displayUrl = urlObj.hostname.replace(/^www\./, '');
        } catch (e) {
        }

        var notes = item.notes || '';
        var notesPreview = notes.length > 10 ? notes.substring(0, 10) + '...' : notes;
        var notesHtml;
        if (notes) {
            notesHtml =
                '<div class="account-notes">' +
                    '<span class="account-notes-text">📝 ' + escapeHtml(notesPreview) + '</span>' +
                    '<button class="btn-edit-notes" data-index="' + originalIndex + '">✏️</button>' +
                '</div>';
        } else {
            notesHtml =
                '<div class="account-notes">' +
                    '<span class="account-notes-text" style="color:#b8b8d0;">无备注</span>' +
                    '<button class="btn-edit-notes" data-index="' + originalIndex + '">✏️</button>' +
                '</div>';
        }

        html +=
            '<li class="account-item">' +
                '<div class="account-info">' +
                    '<div class="account-url">' + escapeHtml(displayUrl) + '</div>' +
                    '<div class="account-username">' +
                        '👤 ' + escapeHtml(item.username) +
                        '<span class="account-date">' + dateStr + '</span>' +
                    '</div>' +
                    '<div class="account-password">' +
                        '🔒 <span class="password-text" data-index="' + originalIndex + '" data-visible="false">••••••••</span>' +
                        '<button class="btn-toggle-pwd" data-index="' + originalIndex + '">👁️</button>' +
                    '</div>' +
                    notesHtml +
                '</div>' +
                '<div class="action-row">' +
                    '<button class="btn-copy" data-index="' + originalIndex + '">📋 复制</button>' +
                    '<button class="btn-delete" data-index="' + originalIndex + '">🗑️</button>' +
                '</div>' +
            '</li>';
    }
    accountList.innerHTML = html;

    var copyBtns = accountList.querySelectorAll('.btn-copy');
    for (var i = 0; i < copyBtns.length; i++) {
        copyBtns[i].addEventListener('click', function() {
            var index = parseInt(this.getAttribute('data-index'));
            copyPassword(index, this);
        });
    }

    var deleteBtns = accountList.querySelectorAll('.btn-delete');
    for (var i = 0; i < deleteBtns.length; i++) {
        deleteBtns[i].addEventListener('click', function() {
            var index = parseInt(this.getAttribute('data-index'));
            deletePassword(index);
        });
    }

    var editNotesBtns = accountList.querySelectorAll('.btn-edit-notes');
    for (var i = 0; i < editNotesBtns.length; i++) {
        editNotesBtns[i].addEventListener('click', function() {
            var index = parseInt(this.getAttribute('data-index'));
            openNotesModal(index);
        });
    }

    var toggleBtns = accountList.querySelectorAll('.btn-toggle-pwd');
    for (var i = 0; i < toggleBtns.length; i++) {
        toggleBtns[i].addEventListener('click', function() {
            var index = parseInt(this.getAttribute('data-index'));
            togglePasswordVisibility(index, this);
        });
    }
}

// =============================================
// 密码显示/隐藏切换
// =============================================
function togglePasswordVisibility(index, button) {
    var span = document.querySelector('.password-text[data-index="' + index + '"]');
    if (!span) return;

    var isVisible = span.getAttribute('data-visible') === 'true';

    if (isVisible) {
        span.textContent = '••••••••';
        span.setAttribute('data-visible', 'false');
        button.textContent = '👁️';
    } else {
        var item = decryptedPasswords[index];
        if (item) {
            span.textContent = item.password;
            span.setAttribute('data-visible', 'true');
            button.textContent = '🙈';
        }
    }
}

// =============================================
// 复制密码
// =============================================
async function copyPassword(index, button) {
    var item = decryptedPasswords[index];
    if (!item) {
        showToast('密码数据不存在');
        return;
    }

    var password = item.password;

    try {
        await navigator.clipboard.writeText(password);
        button.textContent = '✅ 已复制';
        button.classList.add('copied');
        setTimeout(function() {
            button.textContent = '📋 复制';
            button.classList.remove('copied');
        }, 2000);
        showToast('密码已复制到剪贴板');
    } catch (err) {
        fallbackCopy(password);
        button.textContent = '✅ 已复制';
        button.classList.add('copied');
        setTimeout(function() {
            button.textContent = '📋 复制';
            button.classList.remove('copied');
        }, 2000);
        showToast('密码已复制到剪贴板');
    }
}

function fallbackCopy(text) {
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
}

// =============================================
// 保存密码（通过 SAVE_LOGIN 消息）
// =============================================
async function saveFromForm(e) {
    e.preventDefault();

    var urlInput = safeGetElement('url');
    var usernameInput = safeGetElement('username');
    var passwordInput = safeGetElement('password');

    if (!urlInput || !usernameInput || !passwordInput) return;

    var url = urlInput.value.trim();
    var username = usernameInput.value.trim();
    var password = passwordInput.value.trim();

    if (!url || !username || !password) {
        showToast('请填写所有字段');
        return;
    }

    var domain = url;
    try {
        var urlObj = new URL(url);
        domain = urlObj.hostname.replace(/^www\./, '');
    } catch (e) {
    }

    try {
        var response = await sendMessage({
            type: 'SAVE_LOGIN',
            url: url,
            domain: domain,
            username: username,
            password: password
        });

        if (response.success) {
            if (response.action === 'updated') {
                showToast('密码已更新！');
            } else {
                showToast('保存成功！');
            }

            var accountForm = safeGetElement('accountForm');
            if (accountForm) accountForm.reset();
            await fillCurrentTabUrl();
            await loadAndRenderPasswords();
        } else {
            showToast(response.error || '保存失败');
        }
    } catch (e) {
        showToast('保存失败：' + e.message);
    }
}

// =============================================
// 删除密码（通过 DELETE_PASSWORD 消息）
// =============================================
async function deletePassword(index) {
    if (!confirm('确定要删除这条记录吗？')) return;

    try {
        var response = await sendMessage({ type: 'DELETE_PASSWORD', index: index });
        if (response.success) {
            showToast('记录已删除');
            await loadAndRenderPasswords();
        } else {
            showToast(response.error || '删除失败');
        }
    } catch (e) {
        showToast('删除失败：' + e.message);
    }
}

// =============================================
// 清空全部（通过 CLEAR_ALL_PASSWORDS 消息）
// =============================================
async function clearAll() {
    if (!confirm('确定要清空所有记录吗？此操作不可撤销！')) return;

    try {
        var response = await sendMessage({ type: 'CLEAR_ALL_PASSWORDS' });
        if (response.success) {
            decryptedPasswords = [];
            renderPasswords();
            showToast('所有记录已清空');
        } else {
            showToast(response.error || '清空失败');
        }
    } catch (e) {
        showToast('清空失败：' + e.message);
    }
}

// =============================================
// 备注编辑模态框
// =============================================
async function openNotesModal(index) {
    currentEditIndex = index;
    var item = decryptedPasswords[index];
    var currentNotes = item ? (item.notes || '') : '';

    var notesTextarea = safeGetElement('notesTextarea');
    var notesModal = safeGetElement('notesModal');

    if (notesTextarea) notesTextarea.value = currentNotes;
    if (notesModal) notesModal.classList.add('active');

    setTimeout(function() {
        if (notesTextarea) notesTextarea.focus();
    }, 100);
}

function closeNotesModal() {
    var notesModal = safeGetElement('notesModal');
    if (notesModal) notesModal.classList.remove('active');
    currentEditIndex = -1;
}

async function saveNotes() {
    if (currentEditIndex < 0) return;

    var notesTextarea = safeGetElement('notesTextarea');
    var newNotes = notesTextarea ? notesTextarea.value.trim() : '';

    try {
        var response = await sendMessage({
            type: 'UPDATE_NOTES',
            index: currentEditIndex,
            notes: newNotes
        });

        if (response.success) {
            closeNotesModal();
            await loadAndRenderPasswords();
            showToast(newNotes ? '备注已保存' : '备注已清除');
        } else {
            showToast(response.error || '保存备注失败');
        }
    } catch (e) {
        showToast('保存备注失败：' + e.message);
    }
}

// =============================================
// 修改主密码
// =============================================
function openChangePwdModal() {
    var oldPwdInput = safeGetElement('oldPwdInput');
    var newPwdInput = safeGetElement('newPwdInput');
    var newPwdConfirm = safeGetElement('newPwdConfirm');
    var changePwdError = safeGetElement('changePwdError');
    var changePwdModal = safeGetElement('changePwdModal');

    if (oldPwdInput) oldPwdInput.value = '';
    if (newPwdInput) newPwdInput.value = '';
    if (newPwdConfirm) newPwdConfirm.value = '';
    if (changePwdError) changePwdError.style.display = 'none';
    if (changePwdModal) changePwdModal.classList.add('active');
}

function closeChangePwdModal() {
    var changePwdModal = safeGetElement('changePwdModal');
    if (changePwdModal) changePwdModal.classList.remove('active');
}

async function handleChangePwd() {
    var oldPwdInput = safeGetElement('oldPwdInput');
    var newPwdInput = safeGetElement('newPwdInput');
    var newPwdConfirm = safeGetElement('newPwdConfirm');

    var oldPassword = oldPwdInput ? oldPwdInput.value : '';
    var newPassword = newPwdInput ? newPwdInput.value : '';
    var newPwdConfirmValue = newPwdConfirm ? newPwdConfirm.value : '';

    if (!oldPassword || !newPassword || !newPwdConfirmValue) {
        showChangePwdError('请填写所有字段');
        return;
    }
    if (newPassword.length < 6) {
        showChangePwdError('新密码长度至少 6 位');
        return;
    }
    if (newPassword !== newPwdConfirmValue) {
        showChangePwdError('两次输入的新密码不一致');
        return;
    }

    try {
        var response = await sendMessage({
            type: 'CHANGE_MASTER_PASSWORD',
            oldPassword: oldPassword,
            newPassword: newPassword
        });

        if (response.success) {
            closeChangePwdModal();
            showToast('主密码已修改');
        } else {
            showChangePwdError(response.error || '修改失败');
        }
    } catch (e) {
        showChangePwdError('修改失败：' + e.message);
    }
}

function showChangePwdError(message) {
    var errorEl = safeGetElement('changePwdError');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.style.display = 'block';
}

// =============================================
// 安全锁定
// =============================================
async function lockApp() {
    try {
        await sendMessage({ type: 'LOCK' });
    } catch (e) {
    }

    decryptedPasswords = [];
    isUnlocked = false;

    var mainContainer = safeGetElement('mainContainer');
    if (mainContainer) mainContainer.style.display = 'none';

    if (autoLockTimer) {
        clearTimeout(autoLockTimer);
        autoLockTimer = null;
    }

    await initLockScreen();
}

// =============================================
// 自动锁定定时器
// =============================================
function resetAutoLockTimer() {
    if (autoLockTimer) clearTimeout(autoLockTimer);
    autoLockTimer = setTimeout(lockApp, AUTO_LOCK_MS);
}

// =============================================
// Toast 提示
// =============================================
function showToast(message) {
    var toast = safeGetElement('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(function() {
        toast.classList.remove('show');
    }, 2000);
}

// =============================================
// 自动获取当前标签页网址
// =============================================
async function fillCurrentTabUrl() {
    try {
        var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && tabs[0].url) {
            var urlInput = safeGetElement('url');
            if (urlInput) urlInput.value = tabs[0].url;
        }
    } catch (e) {
        console.error('获取标签页网址失败：', e);
    }
}

// =============================================
// 事件绑定和初始化
// =============================================
document.addEventListener('DOMContentLoaded', async function() {
    await initLockScreen();

    var btnUnlock = safeGetElement('btnUnlock');
    if (btnUnlock) {
        btnUnlock.addEventListener('click', handleUnlockClick);
    }

    var masterPasswordInput = safeGetElement('masterPasswordInput');
    if (masterPasswordInput) {
        masterPasswordInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') handleUnlockClick();
        });
    }
    var masterPasswordConfirm = safeGetElement('masterPasswordConfirm');
    if (masterPasswordConfirm) {
        masterPasswordConfirm.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') handleUnlockClick();
        });
    }

    var accountForm = safeGetElement('accountForm');
    if (accountForm) {
        accountForm.addEventListener('submit', saveFromForm);
    }
    var btnClearAll = safeGetElement('btnClearAll');
    if (btnClearAll) {
        btnClearAll.addEventListener('click', clearAll);
    }
    var btnLock = safeGetElement('btnLock');
    if (btnLock) {
        btnLock.addEventListener('click', lockApp);
    }
    var btnChangePwd = safeGetElement('btnChangePwd');
    if (btnChangePwd) {
        btnChangePwd.addEventListener('click', openChangePwdModal);
    }

    var btnModalCancel = safeGetElement('btnModalCancel');
    if (btnModalCancel) {
        btnModalCancel.addEventListener('click', closeNotesModal);
    }
    var btnModalSave = safeGetElement('btnModalSave');
    if (btnModalSave) {
        btnModalSave.addEventListener('click', saveNotes);
    }
    var notesModal = safeGetElement('notesModal');
    if (notesModal) {
        notesModal.addEventListener('click', function(e) {
            if (e.target === this) closeNotesModal();
        });
    }

    var btnChangePwdCancel = safeGetElement('btnChangePwdCancel');
    if (btnChangePwdCancel) {
        btnChangePwdCancel.addEventListener('click', closeChangePwdModal);
    }
    var btnChangePwdSave = safeGetElement('btnChangePwdSave');
    if (btnChangePwdSave) {
        btnChangePwdSave.addEventListener('click', handleChangePwd);
    }
    var changePwdModal = safeGetElement('changePwdModal');
    if (changePwdModal) {
        changePwdModal.addEventListener('click', function(e) {
            if (e.target === this) closeChangePwdModal();
        });
    }

    document.addEventListener('click', resetAutoLockTimer);
    document.addEventListener('keydown', resetAutoLockTimer);
});

// =============================================
// 监听 storage 变化（content.js 自动保存时刷新）
// =============================================
chrome.storage.onChanged.addListener(function(changes, namespace) {
    if (namespace === 'local' && changes['passwords'] && isUnlocked) {
        loadAndRenderPasswords();
    }
});
