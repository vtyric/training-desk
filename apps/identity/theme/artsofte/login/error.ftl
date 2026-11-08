<#ftl output_format="HTML" auto_esc=true>
<#import "template.ftl" as layout>
<#-- The theme owns this translation without username parameters, so matching it is locale-safe. -->
<#assign continueSession = message?? && message.summary == msg('differentUserAuthenticated') && url.ssoLoginInOtherTabsUrl??>
<@layout.registrationLayout displayMessage=false; section>
    <#if section == 'header'>
        <#if continueSession>${msg('trainingContinueSignIn')}<#else>${msg('trainingSignInErrorTitle')}</#if>
    <#elseif section == 'form'>
        <div id="kc-error-message">
            <#if continueSession>
                <p role="status">${msg('trainingContinueSignIn')}</p>
                <div class="federation-actions">
                    <a class="primary-button federation-submit" id="identity-continue-session"
                       href="${url.ssoLoginInOtherTabsUrl}">${msg('trainingContinueAction')}</a>
                </div>
                <script src="${url.resourcesPath}/js/continue-session.js?v=${properties.stylesVersion!'dev'}" defer></script>
            <#else>
                <p class="error-banner" role="alert">${kcSanitize((message.summary)!msg('unexpectedErrorMessage'))?no_esc}</p>
                <div class="federation-actions">
                    <#if !(skipLink??) && client?? && client.baseUrl?has_content>
                        <a class="primary-button federation-submit" id="backToApplication" href="${client.baseUrl}">${msg('backToApplication')}</a>
                    <#elseif url.loginRestartFlowUrl??>
                        <a class="primary-button federation-submit" id="loginRestartLink" href="${url.loginRestartFlowUrl}">${msg('trainingRestartSignIn')}</a>
                    </#if>
                </div>
            </#if>
            <#if traceId??><p class="federation-note" id="traceId">${msg('traceIdSupportMessage', traceId)}</p></#if>
        </div>
    </#if>
</@layout.registrationLayout>
