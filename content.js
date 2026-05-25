// =============================================
// content.js v4 - 智能登录行为识别器（增强兼容版）
// =============================================
// 核心增强：
//   1. Shadow DOM 穿透：递归进入所有 shadowRoot 查找 input
//   2. iframe 支持：同源 iframe 内递归查找，跨域静默跳过
//   3. SPA 动态路由：监听 popstate/hashchange/pushState/replaceState
//   4. MutationObserver：监听属性变化 + 500ms 防抖
//   5. 三重触发机制 + 5 级密码框查找 + 延迟重试
// =============================================

const TAG = '[密码管理器]';
console.log(TAG, 'content.js v4 已注入，当前页面：', window.location.href);

// =============================================
// 全局配置
// =============================================
const CONFIG = {
    COOLDOWN_MS: 2000,
    RETRY_DELAY_MS: 500,
    MAX_RETRY: 3,
    // MutationObserver 防抖间隔（毫秒）
    MUTATION_DEBOUNCE_MS: 500,
    // 动态 DOM 变化后延迟多久触发查找
    DOM_CHANGE_DELAY_MS: 1000,
    // iframe 递归最大深度（防止嵌套过深）
    IFRAME_MAX_DEPTH: 3,
    // Shadow DOM 递归最大深度
    SHADOW_MAX_DEPTH: 10,
    LOGIN_BUTTON_TEXTS: [
        '登录', '登入', '登陆', '注册并登录',
        'sign in', 'log in', 'login', 'signin', 'submit',
        'sign up', 'register', 'continue', '确认', '确定', '提交'
    ],
    LOGIN_BUTTON_ATTRS: [
        'login', 'signin', 'log-in', 'sign-in',
        'submit', 'btn-login', 'btn-sign'
    ],
    USERNAME_ATTRS: [
        'user', 'email', 'account', 'login', 'phone',
        'mobile', 'name', 'uid', 'username'
    ],
    PASSWORD_ATTRS: ['password', 'pwd', 'pass', 'passwd'],
    SEARCH_KEYWORDS: ['search', 'query', 'q', 'keyword'],
    _lastFingerprint: '',
    _lastFingerprintTime: 0
};

// =============================================
// 第一部分：基础工具函数
// =============================================

/**
 * 检查一个 input 元素是否"可见"
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isVisible(el) {
    if (!el) return false;
    // 对于 Shadow DOM 内的元素，offsetParent 可能为 null 但仍可见
    // 所以需要检查 getBoundingClientRect
    try {
        if (el.offsetParent !== null) return true;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    } catch (e) {
        return false;
    }
}

/**
 * 检查一个 input 是否是搜索框（排除误判）
 * @param {HTMLInputElement} input
 * @returns {boolean}
 */
function isSearchInput(input) {
    if (input.type === 'search') return true;
    const attrs = [input.name, input.id, input.placeholder,
        input.getAttribute('role'), input.getAttribute('aria-label')
    ].join(' ').toLowerCase();
    return CONFIG.SEARCH_KEYWORDS.some(kw => attrs.includes(kw));
}

/**
 * 获取元素及最多 N 层父级的 className 拼接字符串
 * @param {HTMLElement} el
 * @param {number} maxDepth
 * @returns {string}
 */
function getClassChain(el, maxDepth = 5) {
    const classes = [];
    let current = el;
    let depth = 0;
    while (current && depth < maxDepth) {
        if (current.host) break; // 到达 Shadow DOM 边界时停止
        const cls = current.className;
        if (typeof cls === 'string' && cls) classes.push(cls.toLowerCase());
        current = current.parentElement;
        depth++;
    }
    return classes.join(' ');
}

/**
 * 获取元素的综合属性字符串（name + id + class + autocomplete + placeholder）
 * @param {HTMLElement} el
 * @returns {string}
 */
function getAttrs(el) {
    return [
        el.name || '', el.id || '',
        (typeof el.className === 'string' ? el.className : ''),
        el.getAttribute('autocomplete') || '', el.placeholder || ''
    ].join(' ').toLowerCase();
}

/**
 * 从 URL 提取域名
 * @param {string} url
 * @returns {string}
 */
function extractDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (e) { return url; }
}

/**
 * 为元素生成调试路径描述
 * 例如："Shadow DOM > div.login-form > input#password"
 * @param {HTMLElement} el
 * @param {string} context - 来源上下文（如 "Shadow DOM", "iframe[src=xxx]"）
 * @returns {string}
 */
function getElementPath(el, context) {
    const parts = [];
    let current = el;
    let depth = 0;
    while (current && current !== document.documentElement && depth < 6) {
        let desc = current.tagName ? current.tagName.toLowerCase() : '?';
        if (current.id) desc += '#' + current.id;
        else if (typeof current.className === 'string' && current.className) {
            desc += '.' + current.className.trim().split(/\s+/)[0];
        }
        parts.unshift(desc);
        current = current.parentElement;
        depth++;
    }
    const path = parts.join(' > ');
    return context ? context + ' :: ' + path : path;
}

// =============================================
// 第二部分：递归 DOM 收集器（Shadow DOM + iframe 穿透）
// =============================================

/**
 * 递归收集所有可见的 input 元素
 *
 * 搜索范围：
 *   1. 当前文档（document 或 iframe 的 contentDocument）
 *   2. 所有 shadowRoot 内部
 *   3. 同源 iframe 内部（递归）
 *
 * @param {Document|ShadowRoot} root - 搜索起点（document 或 shadowRoot）
 * @param {string} context - 上下文标识（用于日志）
 * @param {number} shadowDepth - Shadow DOM 递归深度
 * @param {number} iframeDepth - iframe 递归深度
 * @returns {Array<{input: HTMLInputElement, context: string}>} 收集到的 input 及其来源
 */
function collectAllInputs(root, context, shadowDepth, iframeDepth) {
    const results = [];

    // ---- 收集当前 root 下的直接 input ----
    try {
        const directInputs = root.querySelectorAll('input');
        for (const input of directInputs) {
            if (isVisible(input)) {
                results.push({ input, context });
            }
        }
    } catch (e) {
        // 跨域 iframe 或已失效的 root，静默跳过
        console.warn(TAG, '无法访问 ' + context + ' 的 input 元素：', e.message);
        return results;
    }

    // ---- 穿透 Shadow DOM ----
    if (shadowDepth >= CONFIG.SHADOW_MAX_DEPTH) return results;

    try {
        // 查找当前 root 下所有可能有 shadowRoot 的元素
        const allElements = root.querySelectorAll('*');
        for (const el of allElements) {
            if (el.shadowRoot) {
                const shadowContext = context + ' > Shadow DOM(' +
                    el.tagName.toLowerCase() +
                    (el.id ? '#' + el.id : '') + ')';

                console.log(TAG, '发现 Shadow DOM：' + shadowContext);

                // 递归收集 shadowRoot 内的 input
                const shadowInputs = collectAllInputs(
                    el.shadowRoot, shadowContext, shadowDepth + 1, iframeDepth
                );
                results.push(...shadowInputs);
            }
        }
    } catch (e) {
        console.warn(TAG, '遍历 Shadow DOM 时出错（' + context + '）：', e.message);
    }

    // ---- 穿透同源 iframe ----
    if (iframeDepth >= CONFIG.IFRAME_MAX_DEPTH) return results;

    try {
        const iframes = root.querySelectorAll('iframe');
        for (const iframe of iframes) {
            let iframeDoc;
            try {
                // 尝试访问 iframe 的 contentDocument
                // 同源 → 成功；跨域 → SecurityError
                iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            } catch (e) {
                // 跨域 iframe，静默跳过
                console.log(TAG, '跳过跨域 iframe：' +
                    (iframe.src ? iframe.src.substring(0, 60) : '(无 src)'));
                continue;
            }

            if (!iframeDoc) continue;

            const iframeContext = context + ' > iframe(' +
                (iframe.src ? extractDomain(iframe.src) : '同源') + ')';

            console.log(TAG, '进入同源 iframe：' + iframeContext);

            // 递归收集 iframe 内的 input（包括其内部的 Shadow DOM）
            const iframeInputs = collectAllInputs(
                iframeDoc, iframeContext, shadowDepth, iframeDepth + 1
            );
            results.push(...iframeInputs);
        }
    } catch (e) {
        console.warn(TAG, '遍历 iframe 时出错（' + context + '）：', e.message);
    }

    return results;
}

/**
 * 收集当前页面所有可见 input（包括 Shadow DOM 和同源 iframe）
 * 这是对外的统一入口
 * @returns {Array<{input: HTMLInputElement, context: string}>}
 */
function collectAllInputsGlobally() {
    console.log(TAG, '开始全局 input 收集（含 Shadow DOM + iframe 穿透）...');
    const results = collectAllInputs(document, '主文档', 0, 0);
    console.log(TAG, '全局收集完成，共找到', results.length, '个可见 input');
    return results;
}

// =============================================
// 第三部分：密码框智能查找（5 级优先级，跨 DOM 树）
// =============================================

/**
 * 在所有收集到的 input 中按优先级查找密码框
 *
 * @param {Array<{input, context}>} allInputs - 全局收集的 input 列表
 * @returns {{input: HTMLInputElement, context: string}|null}
 */
function findPasswordFieldFrom(allInputs) {
    console.log(TAG, '在', allInputs.length, '个 input 中查找密码框...');

    // ---- 优先级 1：标准 type="password" ----
    for (const item of allInputs) {
        if (item.input.type === 'password') {
            console.log(TAG, '✓ [优先级1] 找到标准密码框, ' +
                'id=' + (item.input.id || '(无)') +
                ', 路径=' + getElementPath(item.input, item.context));
            return item;
        }
    }
    console.log(TAG, '✗ [优先级1] 未找到 type=password');

    // ---- 优先级 2：autocomplete 包含 current-password 或 new-password ----
    for (const item of allInputs) {
        const ac = (item.input.getAttribute('autocomplete') || '').toLowerCase();
        if (ac.includes('current-password') || ac.includes('new-password')) {
            console.log(TAG, '✓ [优先级2] 通过 autocomplete 找到密码框, ' +
                'autocomplete=' + item.input.getAttribute('autocomplete') +
                ', 路径=' + getElementPath(item.input, item.context));
            return item;
        }
    }
    console.log(TAG, '✗ [优先级2] 未找到 autocomplete 匹配');

    // ---- 优先级 3：name/id 属性包含密码关键词 ----
    for (const item of allInputs) {
        const attrs = getAttrs(item.input);
        if (CONFIG.PASSWORD_ATTRS.some(kw => attrs.includes(kw))) {
            console.log(TAG, '✓ [优先级3] 通过 name/id 找到疑似密码框, ' +
                'type=' + item.input.type +
                ', id=' + (item.input.id || '(无)') +
                ', name=' + (item.input.name || '(无)') +
                ', 路径=' + getElementPath(item.input, item.context));
            return item;
        }
    }
    console.log(TAG, '✗ [优先级3] 未找到 name/id 匹配');

    // ---- 优先级 4：class 或父级 class 包含密码关键词 ----
    for (const item of allInputs) {
        const classChain = getClassChain(item.input, 5);
        if (CONFIG.PASSWORD_ATTRS.some(kw => classChain.includes(kw))) {
            console.log(TAG, '✓ [优先级4] 通过 class/父级class 找到疑似密码框, ' +
                'type=' + item.input.type +
                ', class=' + (item.input.className || '(无)') +
                ', 路径=' + getElementPath(item.input, item.context));
            return item;
        }
    }
    console.log(TAG, '✗ [优先级4] 未找到 class 匹配');

    // ---- 优先级 5：CSS 模拟密码框 ----
    for (const item of allInputs) {
        try {
            const style = window.getComputedStyle(item.input);
            const security = style.webkitTextSecurity ||
                style.getPropertyValue('-webkit-text-security');
            if (security === 'disc' || security === 'circle') {
                console.log(TAG, '✓ [优先级5] 通过 -webkit-text-security 找到模拟密码框, ' +
                    'type=' + item.input.type +
                    ', id=' + (item.input.id || '(无)') +
                    ', 路径=' + getElementPath(item.input, item.context));
                return item;
            }
        } catch (e) { /* getComputedStyle 可能在某些上下文失败 */ }
    }
    console.log(TAG, '✗ [优先级5] 未找到 CSS 模拟密码框');

    console.log(TAG, '× 所有 5 级策略均未找到密码输入框');
    return null;
}

// =============================================
// 第四部分：用户名框智能查找（跨 DOM 树）
// =============================================

/**
 * 根据已找到的密码框，在所有收集到的 input 中查找用户名框
 *
 * @param {{input, context}} passwordItem - 找到的密码框项
 * @param {Array<{input, context}>} allInputs - 全局收集的 input 列表
 * @returns {HTMLInputElement|null}
 */
function findUsernameFieldFrom(passwordItem, allInputs) {
    const passwordField = passwordItem.input;
    const passwordContext = passwordItem.context;

    console.log(TAG, '开始查找用户名框，密码框位于：' + passwordContext);

    // 过滤掉密码框本身和搜索框，只保留可能的用户名框候选
    const candidates = allInputs.filter(item => {
        const input = item.input;
        if (input === passwordField) return false;
        if (!isVisible(input)) return false;
        if (isSearchInput(input)) return false;
        // 只考虑 text 类的输入框
        const type = input.type.toLowerCase();
        return type === 'text' || type === 'email' || type === 'tel' || type === 'url' || type === '';
    });

    console.log(TAG, '过滤后剩余', candidates.length, '个用户名候选');

    // ---- 策略 1：autocomplete="username" 或 "email" ----
    for (const item of candidates) {
        const ac = (item.input.getAttribute('autocomplete') || '').toLowerCase();
        if (ac === 'username' || ac === 'email') {
            console.log(TAG, '✓ [用户名策略1] 通过 autocomplete 找到, ' +
                'autocomplete=' + ac + ', 路径=' + getElementPath(item.input, item.context));
            return item.input;
        }
    }

    // ---- 策略 2：name/id 包含用户名关键词 ----
    for (const item of candidates) {
        const attrs = getAttrs(item.input);
        if (CONFIG.USERNAME_ATTRS.some(kw => attrs.includes(kw))) {
            console.log(TAG, '✓ [用户名策略2] 通过 name/id 关键词找到, ' +
                'id=' + (item.input.id || '(无)') +
                ', name=' + (item.input.name || '(无)') +
                ', 路径=' + getElementPath(item.input, item.context));
            return item.input;
        }
    }

    // ---- 策略 3：与密码框在同一个 <form> 中 ----
    const parentForm = passwordField.closest('form');
    if (parentForm) {
        console.log(TAG, '密码框位于 <form> 内，尝试在同表单中找用户名框');
        const formInputs = parentForm.querySelectorAll('input');
        const formInputArray = Array.from(formInputs);
        const pwdIndex = formInputArray.indexOf(passwordField);

        // 取密码框前方最近的 text/email 输入框
        const beforePwd = candidates.filter(item => {
            return formInputArray.includes(item.input) &&
                formInputArray.indexOf(item.input) < pwdIndex;
        });
        if (beforePwd.length > 0) {
            const best = beforePwd[beforePwd.length - 1];
            console.log(TAG, '✓ [用户名策略3] 取同表单密码框前方最近的输入框, ' +
                'id=' + (best.input.id || '(无)') +
                ', 路径=' + getElementPath(best.input, best.context));
            return best.input;
        }
    }

    // ---- 策略 4：与密码框在同一个父容器中（Shadow DOM 或 iframe 内） ----
    // 从密码框向上查找共同父级，在该父级范围内找最近的 text 输入框
    let ancestor = passwordField.parentElement;
    let depth = 0;
    while (ancestor && depth < 8) {
        const siblingInputs = ancestor.querySelectorAll('input');
        const siblingArray = Array.from(siblingInputs);
        const pwdIdx = siblingArray.indexOf(passwordField);

        const beforeSiblings = candidates.filter(item => {
            return siblingArray.includes(item.input) &&
                siblingArray.indexOf(item.input) < pwdIdx;
        });
        if (beforeSiblings.length > 0) {
            const best = beforeSiblings[beforeSiblings.length - 1];
            console.log(TAG, '✓ [用户名策略4] 在第 ' + depth + ' 层父级中找到, ' +
                'id=' + (best.input.id || '(无)') +
                ', 路径=' + getElementPath(best.input, best.context));
            return best.input;
        }

        // 如果当前层有 shadowRoot 的 host，也要考虑
        if (ancestor.host) {
            ancestor = ancestor.host;
        } else {
            ancestor = ancestor.parentElement;
        }
        depth++;
    }

    // ---- 策略 5：全局找第一个可见的 text/email 输入框（兜底） ----
    if (candidates.length > 0) {
        const fallback = candidates[0];
        console.log(TAG, '✓ [用户名策略5-兜底] 使用第一个可见 text/email 输入框, ' +
            'id=' + (fallback.input.id || '(无)') +
            ', 路径=' + getElementPath(fallback.input, fallback.context));
        return fallback.input;
    }

    console.log(TAG, '× 所有用户名查找策略均未找到');
    return null;
}

// =============================================
// 第五部分：统一触发入口 + 延迟重试 + 防抖去重
// =============================================

/**
 * 统一的登录检测入口
 * @param {string} triggerType - 触发类型标识
 * @param {Event|null} event - 原始事件对象
 */
function onLoginDetected(triggerType, event) {
    console.log(TAG, '========== 触发登录检测 ==========');
    console.log(TAG, '触发方式：' + triggerType);
    console.log(TAG, '当前 URL：' + window.location.href);

    // 防抖检查
    const now = Date.now();
    if (now - CONFIG._lastFingerprintTime < CONFIG.COOLDOWN_MS && CONFIG._lastFingerprint) {
        console.log(TAG, '冷却中（剩余 ' +
            (CONFIG.COOLDOWN_MS - (now - CONFIG._lastFingerprintTime)) + 'ms），跳过');
        return;
    }

    attemptCapture(1);
}

/**
 * 尝试捕获密码（带延迟重试）
 * @param {number} attempt - 当前尝试次数
 */
function attemptCapture(attempt) {
    console.log(TAG, '--- 第 ' + attempt + ' 次尝试查找密码框 ---');

    // 全局收集所有 input（含 Shadow DOM + iframe）
    const allInputs = collectAllInputsGlobally();

    // 查找密码框
    const passwordItem = findPasswordFieldFrom(allInputs);

    if (!passwordItem) {
        if (attempt < CONFIG.MAX_RETRY) {
            console.log(TAG, '未找到密码框，' + CONFIG.RETRY_DELAY_MS +
                'ms 后进行第 ' + (attempt + 1) + ' 次重试');
            setTimeout(() => attemptCapture(attempt + 1), CONFIG.RETRY_DELAY_MS);
        } else {
            console.log(TAG, '× 已重试 ' + CONFIG.MAX_RETRY + ' 次，仍未找到密码框，放弃');
        }
        return;
    }

    // 查找用户名框
    const usernameField = findUsernameFieldFrom(passwordItem, allInputs);

    // 提取值
    const password = passwordItem.input.value.trim();
    const username = usernameField ? usernameField.value.trim() : '';

    console.log(TAG, '提取到账号：' + (username ? username.substring(0, 3) + '***' : '(空)'));
    console.log(TAG, '提取到密码：' + (password ? '***（长度 ' + password.length + '）' : '(空)'));

    if (!password) {
        console.log(TAG, '密码为空，跳过发送');
        return;
    }
    if (!username) {
        console.log(TAG, '用户名为空，跳过发送');
        return;
    }

    // 指纹去重
    const fingerprint = window.location.href + '|' + username + '|' + password;
    if (fingerprint === CONFIG._lastFingerprint &&
        (Date.now() - CONFIG._lastFingerprintTime) < CONFIG.COOLDOWN_MS) {
        console.log(TAG, '指纹重复，跳过');
        return;
    }

    CONFIG._lastFingerprint = fingerprint;
    CONFIG._lastFingerprintTime = Date.now();

    sendToBackground(username, password);
}

/**
 * 发送消息到 background.js
 * @param {string} username
 * @param {string} password
 */
function sendToBackground(username, password) {
    const url = window.location.href;
    const domain = extractDomain(url);

    console.log(TAG, '→ 向后台发送 SAVE_LOGIN 消息');
    console.log(TAG, '  域名：' + domain);
    console.log(TAG, '  账号：' + username.substring(0, 3) + '***');

    chrome.runtime.sendMessage({
        type: 'SAVE_LOGIN',
        url: url,
        domain: domain,
        username: username,
        password: password
    }, function(response) {
        if (chrome.runtime.lastError) {
            console.error(TAG, '✗ 消息发送失败：' + chrome.runtime.lastError.message);
        } else {
            console.log(TAG, '✓ 后台响应：', response);
        }
    });
}

// =============================================
// 第六部分：三重触发机制
// =============================================

// ---- 触发器 1：全局 submit 事件（捕获 + 冒泡双阶段） ----
document.addEventListener('submit', function(event) {
    console.log(TAG, '[触发器1-捕获] 检测到 submit 事件');
    onLoginDetected('submit事件(捕获)', event);
}, true);

document.addEventListener('submit', function(event) {
    console.log(TAG, '[触发器1-冒泡] 检测到 submit 事件');
    onLoginDetected('submit事件(冒泡)', event);
}, false);

// ---- 触发器 2：登录按钮点击 ----
document.addEventListener('click', function(event) {
    const target = event.target;
    const clickable = target.closest(
        'button, [type="submit"], [role="button"], a.btn, ' +
        '[class*="btn"], [class*="login"], [class*="submit"]'
    );
    if (!clickable) return;

    const btnText = (clickable.textContent || '').trim().toLowerCase();
    const btnClass = (clickable.className || '').toString().toLowerCase();
    const btnId = (clickable.id || '').toLowerCase();
    const btnAttrs = btnClass + ' ' + btnId;

    const isLoginByText = CONFIG.LOGIN_BUTTON_TEXTS.some(kw => btnText.includes(kw));
    const isLoginByAttr = CONFIG.LOGIN_BUTTON_ATTRS.some(kw => btnAttrs.includes(kw));

    if (isLoginByText || isLoginByAttr) {
        console.log(TAG, '[触发器2] ✓ 登录按钮点击, 文字="' + btnText.substring(0, 20) +
            '", class="' + btnClass.substring(0, 30) + '"');
        setTimeout(() => onLoginDetected('登录按钮点击', event), 100);
    }
}, true);

// ---- 触发器 3：Enter 键 ----
document.addEventListener('keydown', function(event) {
    if (event.key !== 'Enter' && event.keyCode !== 13) return;
    const activeEl = document.activeElement;
    if (!activeEl || activeEl.tagName !== 'INPUT') return;

    console.log(TAG, '[触发器3] Enter 键按下, id=' + (activeEl.id || '(无)') +
        ', type=' + activeEl.type);
    onLoginDetected('Enter键', event);
}, true);

// =============================================
// 第七部分：MutationObserver（带 500ms 防抖）
// =============================================

let mutationTimer = null;

/**
 * MutationObserver 回调（防抖处理）
 * 500ms 内多次 DOM 变动只触发一次查找
 */
function onDOMChanged() {
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(function() {
        console.log(TAG, '[MutationObserver] DOM 稳定后检测到变化');

        // 快速检查是否有新的密码框出现
        const allInputs = collectAllInputsGlobally();
        const hasPasswordField = allInputs.some(item => item.input.type === 'password');

        if (hasPasswordField) {
            console.log(TAG, '[MutationObserver] 检测到密码框存在，但不自动触发');
            console.log(TAG, '  等待用户操作（点击登录/按回车/提交表单）...');
            // 不自动触发查找，由用户行为触发
            // 但这里可以做预热：记录密码框位置，加速后续查找
        }
    }, CONFIG.MUTATION_DEBOUNCE_MS);
}

// 启动 MutationObserver
const observer = new MutationObserver(function(mutations) {
    // 检查是否有新增节点或属性变化
    let hasRelevantChange = false;

    for (const mutation of mutations) {
        // 子节点变化
        if (mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                // 新增的 input 或包含 input 的容器
                if (node.tagName === 'INPUT' ||
                    (node.querySelector && node.querySelector('input'))) {
                    hasRelevantChange = true;
                    break;
                }
            }
        }

        // 属性变化（某些 SPA 通过修改属性来切换 input 类型）
        if (mutation.type === 'attributes') {
            const target = mutation.target;
            if (target.tagName === 'INPUT') {
                hasRelevantChange = true;
            }
        }

        if (hasRelevantChange) break;
    }

    if (hasRelevantChange) {
        onDOMChanged();
    }
});

function startObserver() {
    if (document.body) {
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['type', 'class', 'style', 'autocomplete', 'name', 'id']
        });
        console.log(TAG, 'MutationObserver 已启动（监听子节点 + 属性变化）');
    } else {
        document.addEventListener('DOMContentLoaded', function() {
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['type', 'class', 'style', 'autocomplete', 'name', 'id']
            });
            console.log(TAG, 'DOMContentLoaded 后 MutationObserver 已启动');
        });
    }
}

startObserver();

// =============================================
// 第八部分：SPA 动态路由监听
// =============================================

/**
 * 重置防抖标志（用于 SPA 页面切换）
 * 当 URL 变化时，旧的指纹不再有效，需要允许重新捕获
 */
function resetFingerprintForNewRoute() {
    console.log(TAG, '[SPA] 检测到路由变化，重置防抖标志');
    CONFIG._lastFingerprint = '';
    CONFIG._lastFingerprintTime = 0;
    // 给新页面一点时间渲染，然后准备捕获
    console.log(TAG, '[SPA] 已准备好捕获新页面的登录');
}

// ---- 监听 popstate（浏览器前进/后退按钮） ----
window.addEventListener('popstate', function() {
    console.log(TAG, '[SPA] popstate 事件触发，新 URL：' + window.location.href);
    resetFingerprintForNewRoute();
});

// ---- 监听 hashchange（# 锚点变化） ----
window.addEventListener('hashchange', function() {
    console.log(TAG, '[SPA] hashchange 事件触发，新 URL：' + window.location.href);
    resetFingerprintForNewRoute();
});

// ---- 劫持 history.pushState 和 history.replaceState ----
// SPA 框架（React Router、Vue Router 等）通过这两个 API 改变 URL 而不刷新页面
// 标准的 popstate 事件在 pushState 时不触发，所以需要手动劫持

(function() {
    // 保存原始方法
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    // 劫持 pushState
    history.pushState = function() {
        // 调用原始方法
        const result = originalPushState.apply(this, arguments);
        console.log(TAG, '[SPA] pushState 被调用，新 URL：' + window.location.href);
        // 触发路由变化处理
        window.dispatchEvent(new Event('locationchange'));
        return result;
    };

    // 劫持 replaceState
    history.replaceState = function() {
        const result = originalReplaceState.apply(this, arguments);
        console.log(TAG, '[SPA] replaceState 被调用，新 URL：' + window.location.href);
        window.dispatchEvent(new Event('locationchange'));
        return result;
    };
})();

// 监听自定义的 locationchange 事件
window.addEventListener('locationchange', function() {
    resetFingerprintForNewRoute();
});

// =============================================
// 初始化完成
// =============================================
console.log(TAG, '════════════════════════════════════════════');
console.log(TAG, 'content.js v4 初始化完成');
console.log(TAG, '能力清单：');
console.log(TAG, '  ✓ Shadow DOM 穿透（最大深度 ' + CONFIG.SHADOW_MAX_DEPTH + '）');
console.log(TAG, '  ✓ 同源 iframe 穿透（最大深度 ' + CONFIG.IFRAME_MAX_DEPTH + '）');
console.log(TAG, '  ✓ SPA 路由监听（popstate/hashchange/pushState/replaceState）');
console.log(TAG, '  ✓ MutationObserver（子节点 + 属性变化，' + CONFIG.MUTATION_DEBOUNCE_MS + 'ms 防抖）');
console.log(TAG, '  ✓ 三重触发（submit | 登录按钮 | Enter）');
console.log(TAG, '  ✓ 5 级密码框查找优先级');
console.log(TAG, '  ✓ 延迟重试（最多 ' + CONFIG.MAX_RETRY + ' 次，间隔 ' + CONFIG.RETRY_DELAY_MS + 'ms）');
console.log(TAG, '等待用户执行登录操作...');
console.log(TAG, '════════════════════════════════════════════');
