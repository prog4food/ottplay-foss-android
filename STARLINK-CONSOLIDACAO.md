# STARLINK IPTV — Consolidação Android

## Objetivo
Entregar um único APK Android STARLINK IPTV, preservando os projetos originais e suas licenças.

## Repositório e branch de trabalho
- Destino: sempaio/ottplay-foss-android
- Branch: starlink/consolidacao-android
- main: não modificar

## Fontes identificadas
- sempaio/ottplay-foss-android: base importada para a branch starlink/import-ottplay-foss
- sempaio/ottplay-foss: player web/servidor local Rust
- sempaio/ottplay-android: app Android nativo Kotlin/Jetpack Compose, Media3/ExoPlayer
- sempaio/ottplay-netflix: proposta de tema visual CSS e workflow de APK
- sempaio/ottplay-control-server: projeto de servidor; não embutir indiscriminadamente no APK
- sempaio/painel-m81-iptv-cloud: backend/painel operacional separado

## Regras de integração
1. Inventariar arquivos e licenças de cada origem antes de copiar código.
2. Escolher um único runtime Android; não combinar diretamente projetos nativos e web sem adaptadores.
3. Aplicar marca STARLINK IPTV, navegação estilo catálogo, login por usuário e senha e endereço configurável do servidor.
4. Não inserir credenciais reais no repositório nem no APK.
5. Preservar atribuições e licenças; registrar origem e commit dos trechos reaproveitados.
6. Validar build Android e disponibilizar APK de teste por GitHub Actions antes de qualquer publicação.
7. Não alterar produção do painel M81, fontes, playlists ou publicação ativa.

## Estado
Branch de consolidação criada. Inventário e integração de código pendentes. Nenhum APK validado nesta etapa.
