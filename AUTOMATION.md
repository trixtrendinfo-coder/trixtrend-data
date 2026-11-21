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

`GITHUB_TOKEN` galioja konkretaus darbo vykdymo metu. Jis naudojamas
`session.enc.json`, `quant-gold.json` ir savaitinių „Telegram“ įrašų būsenai.
Darbo eigos naudoja „GitHub Actions“ suteiktą raktą ir nevykdomos iš „pull request“.

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

## „Quant Gold“ ataskaita į „Telegram“

„GitHub Actions“ publikavimas numatytas sekmadieniais 10.30 val. Vilniaus laiku.
Į ataskaitą įtraukiami uždarymai nuo pirmadienio pradžios iki šeštadienio pabaigos
pagal „cTrader“ ataskaitų UTC+2 laiką. Taip įtraukiami ir penktadienio sesijos
uždarymai, kurie UTC+2 laiku jau patenka į šeštadienį. Savaitės pokytis
skaičiuojamas dauginant to laikotarpio uždarymų grąžas pagal svetainės metodiką.
Kiekvienas dalinis uždarymas laikomas atskiru įvykdymu. Skaičiuojami ir uždarymai
su nuliniu rezultatu.

Po kortele pateikiamas trumpas angliškas komentaras apie strategijos savaitės
rezultatą ir bendrą rinkos foną. Rinkos fonui naudojami tos savaitės [Cboe
numatomo kintamumo duomenys](https://www.cboe.com/tradable_products/vix/vix_historical_data).
Komentare neminimi atskiri instrumentai ar sandoriai. Jeigu savaitės rinkos
duomenų nepakanka, komentare apibūdinamas patikrintas strategijos rezultatas.

1. Paruošk paketą komanda `node scripts/package-deployment.mjs`. Įkelk `deploy/`
   failus į `trixtrendinfo-coder/trixtrend-data` saugyklos `main` šaknį, o
   `telegram-weekly.yml` į `.github/workflows/telegram-weekly.yml`.
2. Užbaik „cTrader Open API“ tik skaitymo prijungimą ir nustatyk `CTRADER_CONFIGURED=true`.
   „Actions“ atidaryk **Quant Gold weekly Telegram report**, nurodyk norimos
   savaitės pirmadienį `week_of` ir palik `publish` išjungtą. Atsisiųsk sukurtą
   peržiūros artefaktą ir palygink jo duomenis su „cTrader“ istorija. Po sutikrinimo
   nustatyk `CTRADER_WEEKLY_VERIFIED=true`.
3. „Trix Trend Algo Monitor“ kanale suteik botui administratoriaus teisę skelbti
   pranešimus. Boto raktą įrašyk į „GitHub Actions“ paslaptį `TELEGRAM_BOT_TOKEN`.
   Numatytoji paskirtis `@TrixTrendAlgoMonitor`. Jei kanalas neturi viešo
   naudotojo vardo, įrašyk skaitinį kanalo ID į `TELEGRAM_CHAT_ID` kintamąjį.
4. Įjunk `TELEGRAM_WEEKLY_ENABLED=true`. Jei vieną iš ateinančių ataskaitų jau
   suplanuoji rankiniu būdu, `TELEGRAM_WEEKLY_START` nurodyk pirmosios automatinės
   ataskaitos savaitės pirmadienį. Pavyzdžiui, jei lapkričio 22 d. įrašas
   suplanuotas ranka, `2026-11-23` reiškia pirmą automatinį įrašą lapkričio 29 d.

Rankiniam publikavimui aiškiai įvesk tos savaitės pirmadienį ir pažymėk
`publish`. Savaitės būseną saugo `telegram-weeks/YYYY-MM-DD.json`. Joje yra
datos, būsena ir sėkmingai paskelbto įrašo ID. Telegram patvirtinus atmetimą
(`failed`), ištaisyk priežastį ir paleisk konkretų laikotarpį iš naujo.
Jeigu po siuntimo būsena lieka `pending`, pirmiausia patikrink kanalą, kol darbo
eiga nevykdoma. Jei įrašas matomas, būsenos failą pakeisk į `sent` ir įrašyk jo
skaitinį `messageId`. Jei patvirtinai, kad įrašo nėra, pakeisk būseną į `failed`
ir pakartok tos savaitės rankinį paleidimą.

„Telegram“ darbo eiga naudoja patikrintą „cTrader“ istoriją ir išsaugo atnaujintą
skaitymo sesiją. Svetainės `quant-gold.json` ji nerašo. Praleistam sekmadieniui
skelbtiną savaitę galima pasirinkti rankiniu būdu. GitHub suplanuotus paleidimus
gali atidėti. Viešos saugyklos neveiklumas 60 dienų gali išjungti suplanuotą eigą.
