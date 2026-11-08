<#ftl output_format="HTML" auto_esc=true>
<#import "federation.ftl" as federation>
<#-- Keep the Keycloak 26.7 registrationLayout API so inherited action pages share our shell. -->
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
    <@federation.page>
        <h1 id="kc-page-title" class="federation-page-title"><#nested "header"></h1>
        <#if displayRequiredFields><p class="federation-note">${msg('requiredFields')}</p></#if>
        <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
            <p class="<#if message.type == 'error'>error-banner<#else>success-note</#if>" role="alert">${kcSanitize(message.summary)?no_esc}</p>
        </#if>
        <div class="federation-action-content"><#nested "form"></div>
        <#if displayInfo><div class="federation-note"><#nested "info"></div></#if>
    </@federation.page>
</#macro>
