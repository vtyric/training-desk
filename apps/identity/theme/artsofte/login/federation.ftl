<#ftl output_format="HTML" auto_esc=true>
<#macro page>
<!doctype html>
<html lang="${(locale.currentLanguageTag)!'ru'}" data-theme="abanking">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>${properties.federationTitle!'Artsofte Federation'}</title>
    <link rel="icon" type="image/svg+xml" href="${url.resourcesPath}/images/favicon.svg?v=${properties.stylesVersion!'dev'}" sizes="any" />
    <link rel="stylesheet" href="${url.resourcesPath}/css/theme.css?v=${properties.stylesVersion!'dev'}" />
    <#if url.ssoLoginInOtherTabsUrl??>
        <script type="module">
            <#outputformat "JavaScript">
            import { startSessionPolling, checkAuthSession } from ${(url.resourcesPath + "/js/authChecker.js")?c};
            startSessionPolling(${url.ssoLoginInOtherTabsUrl?c});
            <#if authenticationSession??>
                checkAuthSession(${authenticationSession.authSessionIdHash?c});
            </#if>
            </#outputformat>
        </script>
    </#if>
    <#if scripts??>
        <#list scripts as script><script src="${script}" type="text/javascript"></script></#list>
    </#if>
</head>
<body class="federation-page">
    <a class="federation-skip" href="#identity-content">${msg('trainingSkipToForm')}</a>
    <main class="federation-shell">
        <section class="federation-art" aria-hidden="true">
            <div class="federation-art-grid"></div>
            <div class="federation-orbit federation-orbit-one"></div>
            <div class="federation-orbit federation-orbit-two"></div>
            <div class="federation-orbit federation-orbit-three"></div>
            <div class="federation-plane"></div>
            <div class="federation-art-mark">a<span>↗</span></div>
        </section>
        <section class="federation-content" aria-labelledby="identity-brand">
            <div class="federation-form-wrap">
                <p id="identity-brand" class="federation-brand">${properties.federationTitle!'Artsofte Federation'}</p>
                <div id="identity-content" tabindex="-1"><#nested></div>
            </div>
        </section>
    </main>
</body>
</html>
</#macro>
