<#ftl output_format="HTML" auto_esc=true>
<#import "federation.ftl" as federation>
<@federation.page>
    <h1 id="identity-title">${msg('trainingSignInTitle')}</h1>
    <p class="federation-intro">${msg('trainingSignIn')}</p>
    <#if realm.password>
        <form id="identity-form" action="${url.loginAction}" method="post">
            <#if !usernameHidden??>
                <div class="federation-field">
                    <label for="username">${msg('username')}</label>
                    <input id="username" name="username" value="${(login.username!'')}" type="text"
                           autocomplete="username" autofocus required dir="ltr"
                           aria-describedby="identity-note<#if messagesPerField.existsError('username','password')> identity-error</#if>"
                           aria-invalid="${messagesPerField.existsError('username','password')?c}" />
                </div>
            </#if>
            <div class="federation-field">
                <label for="password">${msg('password')}</label>
                <input id="password" name="password" type="password" autocomplete="current-password" required
                       aria-describedby="identity-note<#if messagesPerField.existsError('username','password')> identity-error</#if>"
                       aria-invalid="${messagesPerField.existsError('username','password')?c}" />
            </div>
            <#if messagesPerField.existsError('username','password')>
                <p id="identity-error" class="error-banner" role="alert">${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}</p>
            <#elseif message?has_content>
                <p class="<#if message.type == 'error'>error-banner<#else>success-note</#if>" role="alert">${kcSanitize(message.summary)?no_esc}</p>
            </#if>
            <input type="hidden" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if> />
            <button class="primary-button federation-submit federation-login-submit" id="kc-login" name="login" type="submit">${msg('doLogIn')}</button>
        </form>
    <#else>
        <p class="error-banner" role="alert">${msg('trainingPasswordUnavailable')}</p>
    </#if>
    <p id="identity-note" class="federation-note">${msg('trainingCredentialsNote')}</p>
</@federation.page>
