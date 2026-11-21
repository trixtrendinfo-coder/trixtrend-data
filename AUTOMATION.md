# Trix Trend automatinis duomenų atnaujinimas

Grafikas svetainėje jau skaito `quant-gold.json` iš GitHub. cTrader surinkiklio
paleidimas yra atskiras žingsnis: prieš jį reikia patvirtintos Open API programos,
savininko suteiktos tik skaitymo prieigos ir sutikimo laikyti tą prieigą GitHub Secrets.

## Kas perduodama į viešą failą

Datos, grąžos indeksas, atnaujinimo laikas ir savininko nustatytas −12,07 % DD.
Tai visos ankstesniame grafike naudotos sąskaitos uždarytų sandorių istorija.
Balansai, piniginės sumos, sandorių identifikatoriai, komentarai, prisijungimo raktai
ir atvirų pozicijų informacija į viešą grafiko failą nepatenka.

## Skaičiavimas ir patikrinimai

Kiekvieno uždarymo grynasis rezultatas dalijamas iš balanso prieš uždarymą,
grąžos dauginamos. Komisinių ir swap įtaka įtraukta. Įnešimai ir išėmimai nėra grąža.
Atvirų pozicijų vertė neskaičiuojama; tai nėra pilna equity ar tikslus TWR matas.
Istorinių ataskaitų laiko žymos buvo UTC+2; API UTC laikas sulyginamas su jomis.
Skelbimas stabdomas, jei senoji kreivė nesutampa su patikrinta ataskaita,
pasikeičia sąskaita surinkimo metu ar gaunama neatpažinta komisinių/konvertavimo taisyklė.

## Prieigos apsauga

`CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`, `CTRADER_ACCOUNT_LOGIN`,
`CTRADER_TOKEN_BUNDLE` ir `STATE_KEY` įvedami tik GitHub Actions Secrets.
Pradinį tokenų rinkinį sudaro `accessToken`, `refreshToken`, `expiresAt` (Unix ms).
`STATE_KEY` – atsitiktinis 32 baitų raktas, pateiktas 64 šešioliktainiais simboliais.
Viešame `session.enc.json` saugomi tik AES-256-GCM užšifruoti tokenai.
Jų iššifravimo raktas laikomas Secrets, ne saugykloje. Šifruota būsena reikalinga,
nes atnaujinant cTrader prieigą senasis refresh tokenas tampa nebegaliojantis.
Atnaujintas tokenas išsaugomas prieš renkant istoriją. Jei procesas nutrūktų tarp
atnaujinimo ir išsaugojimo, reikėtų iš naujo suteikti skaitymo prieigą.

`GITHUB_TOKEN` galioja konkretaus darbo vykdymo metu ir naudojamas tik dviem failams
atnaujinti (`session.enc.json`, `quant-gold.json`). Nėra asmeninio GitHub API rakto.
Workflow nenaudoja pull_request ar pull_request_target ir neįdiegia npm paketų.

## Paleidimo seka

1. GitHub patikrinimai: `node --test *.test.mjs`.
2. Užpildomi Secrets ir įjungiamas `CTRADER_CONFIGURED=true`.
3. Rankinis **Verify** paleidimas (`publish=false`): nuskaito ir patikrina istoriją.
4. Sutikrinamas rezultatas su patvirtinta sąskaita ir duomenų laikotarpiu.
5. Įjungiamas `SYNC_ENABLED=true`; nuo tada užduotis planuojama kas 30 min.

GitHub suplanuoti paleidimai gali vėluoti. Grafike rodomas faktinis paskutinio
duomenų surinkimo laikas, o uždelsimas ilgesnis kaip 2 valandos pažymimas.
Pasikeitus nemokamų paslaugų sąlygoms, atšaukus prieigą arba įvykus paslaugos
gedimui gali prireikti savininko veiksmo. Momentinis ar nenutrūkstamas atnaujinimas
nėra garantuojamas.

## Esama būsena

Open API programa `Trix Trend Performance` (49920) pateikta cTrader patvirtinimui.
Tikri tokenai dar neįvesti; prekybos užklausų programoje nėra.
Gamybinis surinkimas turi likti išjungtas, kol neįvykdyti pirmiau aprašyti patikrinimai.
