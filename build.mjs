// Descarga cada día los precios de Pokémon de TCGCSV (copia diaria de TCGPlayer, inglés y japonés) y los deja como
// archivos JSON estáticos para la app Mikon, con el histórico de los últimos HISTORY_DAYS días de cada carta.
// Así TCGCSV recibe una descarga al día y no una por cada móvil.
//
// Uso: node build.mjs <carpeta de salida>   (la carpeta tiene lo ya publicado: el script le añade el día de hoy)
//
// Archivos (las cartas se identifican por su productId de TCGPlayer, el mismo que da TCGdex):
//   index.json           { updated, start, days, currentShards, historyShards }
//   c/<pid % 256>.json   precio actual: { <pid>: { <acabado>: [mercado, mínimo, mercado hace 7 días, mercado hace 30 días] } }
//   h/<pid % 4096>.json  histórico: { start, s: { <pid>: { <acabado>: [céntimos del día 0, del día 1, ...] } } }
//                        un valor por día desde start (null si ese día no hubo precio)
//   trends.json          tendencias del mercado (solo cartas sueltas): las que más suben y bajan en 7 y 30 días y las
//                        más caras, por idioma, con su id e imagen de TCGdex (ver buildTrends)
// Acabados con el nombre de TCGdex: normal, holofoil, reverse-holofoil, 1st-edition-holofoil...

import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises'
import path from 'node:path'

const TCGCSV_URL = 'https://tcgcsv.com'
// 3: Pokémon · 85: Pokémon japonés
const CATEGORIES = [3, 85]
// TCGCSV bloquea las peticiones que no identifican la aplicación
const USER_AGENT = 'MikonPriceFeed/1.0.0'
// TCGCSV pide una pausa entre peticiones
const REQUEST_PAUSE_MS = 150
const RETRIES = 3
const HISTORY_DAYS = 90
const CURRENT_SHARDS = 256
const HISTORY_SHARDS = 4096

// Tendencias: cartas por lista e idioma, y precio mínimo para entrar (por debajo, un salto de 0,10 a 0,30 $
// sería un +200 % sin importancia)
const TRENDS_PER_LIST = 50
const TRENDS_MIN_PRICE = 5
const TRENDS_MIN_FROM = 2
// Candidatas que se revisan por lista (se descartan los productos sellados al ver sus datos)
const TRENDS_CANDIDATES = 400
const TCGDEX_URL = 'https://api.tcgdex.net/v2'
const LANGUAGE_BY_CATEGORY = { 3: 'en', 85: 'ja' }

const DAY_MS = 24 * 3600 * 1000
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const addDays = (date, days) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10)
const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY_MS)

// "Reverse Holofoil" -> "reverse-holofoil" (como los acabados de TCGdex)
const finishKey = (subType) => (subType || 'normal').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const toCents = (price) => price > 0 ? Math.round(price * 100) : null
const fromCents = (cents) => cents === null || cents === undefined ? null : cents / 100

const request = async (url) => {
  for (let attempt = 1; ; attempt++) {
    await sleep(REQUEST_PAUSE_MS)

    try {
      const res = await fetch(`${TCGCSV_URL}${url}`, { headers: { 'User-Agent': USER_AGENT } })
      if(!res.ok) throw new Error(`${res.status} ${url}`)
      return await res.text()
    } catch (e) {
      if(attempt >= RETRIES) throw e
      await sleep(2000 * attempt)
    }
  }
}

const requestJson = async (url) => {
  const data = JSON.parse(await request(url))
  if(!data.success) throw new Error(`${url}: ${JSON.stringify(data.errors)}`)
  return data.results || []
}

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    return null
  }
}

const main = async () => {
  const out = process.argv[2]
  if(!out) throw new Error('Uso: node build.mjs <carpeta de salida>')

  // Momento de la última actualización de TCGCSV: si es la que ya está publicada, no hay nada que hacer
  const updated = (await request('/last-updated.txt')).trim()
  const published = await readJson(path.join(out, 'index.json'))
  const changed = published?.updated !== updated || !!process.env.FORCE

  if(process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)

  if(!changed){
    console.log(`Sin cambios: ya están publicados los precios de ${updated}`)
    return
  }

  const day = updated.slice(0, 10)

  // ---- Precios de hoy: { pid: { acabado: { market, low } } }
  const today = new Map()
  // De qué categoría y expansión es cada producto (para las tendencias)
  const productGroup = new Map()
  const failed = []
  let groupCount = 0

  for (const category of CATEGORIES) {
    let groups = await requestJson(`/tcgplayer/${category}/groups`)
    // Para pruebas: GROUPS=23228,24380 descarga solo esas expansiones
    if(process.env.GROUPS) groups = groups.filter(e => process.env.GROUPS.split(',').includes(String(e.groupId)))

    for (const group of groups) {
      try {
        const prices = await requestJson(`/tcgplayer/${category}/${group.groupId}/prices`)
        groupCount++

        for (const price of prices) {
          // Solo el precio de mercado (sale de ventas reales). El medio sale de los anuncios, y algunos son
          // absurdos (99.999 $): sin precio de mercado, la app sigue con el de TCGdex
          const market = price.marketPrice > 0 ? price.marketPrice : null
          if(!market) continue

          productGroup.set(price.productId, { category, groupId: group.groupId, groupName: group.name, abbreviation: group.abbreviation })
          const finishes = today.get(price.productId) || {}
          finishes[finishKey(price.subTypeName)] = { market, low: price.lowPrice ?? null }
          today.set(price.productId, finishes)
        }
      } catch (e) {
        failed.push(group.name)
        console.log(`::warning::${group.name}: ${e.message}`)
      }
    }
  }

  if(today.size == 0) throw new Error('No se ha podido descargar ningún precio')

  // ---- Histórico: lo ya publicado, alineado a una fecha de inicio común y con el día de hoy añadido
  const previousStart = published?.start || day
  const start = addDays(day, -(HISTORY_DAYS - 1)) > previousStart ? addDays(day, -(HISTORY_DAYS - 1)) : previousStart
  const length = daysBetween(start, day) + 1

  // Lo publicado de cada shard de histórico (se lee bajo demanda)
  const previousShards = new Map()
  const previousHistory = async (pid) => {
    const shard = pid % HISTORY_SHARDS
    if(!previousShards.has(shard)) previousShards.set(shard, await readJson(path.join(out, 'h', `${shard}.json`)))
    return previousShards.get(shard)?.s?.[pid] || null
  }

  const offset = daysBetween(previousStart, start)
  const history = new Map()
  const pids = new Set([...today.keys()])

  // Productos que hoy no tienen precio pero sí histórico: se conservan (con el día de hoy vacío)
  if(published){
    for (let shard = 0; shard < HISTORY_SHARDS; shard++) {
      const data = await readJson(path.join(out, 'h', `${shard}.json`))
      previousShards.set(shard, data)
      for (const pid of Object.keys(data?.s || {})) pids.add(Number(pid))
    }
  }

  for (const pid of pids) {
    const previous = await previousHistory(pid) || {}
    const finishes = {}

    for (const finish of new Set([...Object.keys(previous), ...Object.keys(today.get(pid) || {})])) {
      const values = (previous[finish] || []).slice(offset)
      // Días sin publicar (si la tarea falló algún día): vacíos
      while(values.length < length - 1) values.push(null)
      values.length = length - 1
      values.push(toCents(today.get(pid)?.[finish]?.market))
      // Sin ningún precio en todo el periodo: fuera
      if(values.some(v => v !== null)) finishes[finish] = values
    }

    if(Object.keys(finishes).length > 0) history.set(pid, finishes)
  }

  // ---- Escribir
  await rm(path.join(out, 'c'), { recursive: true, force: true })
  await rm(path.join(out, 'h'), { recursive: true, force: true })
  await mkdir(path.join(out, 'c'), { recursive: true })
  await mkdir(path.join(out, 'h'), { recursive: true })

  const currentShards = Array.from({ length: CURRENT_SHARDS }, () => ({}))
  const historyShards = Array.from({ length: HISTORY_SHARDS }, () => ({}))

  for (const [pid, finishes] of history) {
    historyShards[pid % HISTORY_SHARDS][pid] = finishes

    const current = {}
    for (const [finish, values] of Object.entries(finishes)) {
      const now = today.get(pid)?.[finish]
      if(!now) continue
      const at = (daysAgo) => fromCents(values[values.length - 1 - daysAgo])
      current[finish] = [now.market, now.low, at(7), at(30)]
    }
    if(Object.keys(current).length > 0) currentShards[pid % CURRENT_SHARDS][pid] = current
  }

  await Promise.all(currentShards.map((data, shard) => writeFile(path.join(out, 'c', `${shard}.json`), JSON.stringify(data))))
  await Promise.all(historyShards.map((data, shard) => writeFile(path.join(out, 'h', `${shard}.json`), JSON.stringify({ start, s: data }))))

  // ---- Tendencias del mercado
  try {
    const trends = await buildTrends({ history, today, productGroup, length })
    await writeFile(path.join(out, 'trends.json'), JSON.stringify({ updated, days: length, ...trends }))
  } catch (e) {
    // Sin tendencias se publican igualmente los precios
    console.log(`::warning::trends: ${e.message}`)
  }

  // Con expansiones fallidas no se marca el día como publicado: la siguiente ejecución lo vuelve a intentar
  await writeFile(path.join(out, 'index.json'), JSON.stringify({
    updated: failed.length > 0 ? `${updated} (incompleto)` : updated,
    start,
    days: length,
    currentShards: CURRENT_SHARDS,
    historyShards: HISTORY_SHARDS,
  }))

  console.log(`${groupCount} expansiones · ${today.size} productos con precio hoy · ${history.size} con histórico · ${length} días desde ${start}${failed.length > 0 ? ` · ${failed.length} expansiones con fallos` : ''}`)
}

// ---- Tendencias ----
// Variación de cada producto en `days` días (con el acabado de más valor hoy). Se compara con el precio más
// cercano a hace `days` días dentro del histórico; con menos días de histórico, con el más antiguo
const changesOver = (history, today, length, days) => {
  const back = Math.min(days, length - 1)
  if(back < 1) return []

  const changes = []
  for (const [pid, finishes] of history) {
    let best = null
    for (const [finish, values] of Object.entries(finishes)) {
      const now = today.get(pid)?.[finish]?.market
      if(!(now >= TRENDS_MIN_PRICE)) continue
      // El primer precio conocido desde hace `back` días
      const from = fromCents(values.slice(values.length - 1 - back).find(v => v !== null))
      if(!(from >= TRENDS_MIN_FROM) || (best && best.price >= now)) continue
      best = { pid, finish, price: now, from, change: (now - from) / from * 100 }
    }
    if(best && best.change !== 0) changes.push(best)
  }
  return changes
}

const tcgdexJson = async (url) => {
  await sleep(REQUEST_PAUSE_MS)
  const res = await fetch(`${TCGDEX_URL}${url}`)
  if(!res.ok) return null
  return res.json()
}

// Lista de cartas de TCGdex de la expansión de un grupo de TCGPlayer: inglés por el código impreso (OBF) y el total;
// japonés, el código es el id de la expansión (SV5a). Se guarda por grupo
const tcgdexSets = new Map()
const tcgdexSetFor = async (info, total) => {
  const key = `${info.category}-${info.groupId}`
  if(tcgdexSets.has(key)) return tcgdexSets.get(key)

  let set = null
  try {
    const code = (info.abbreviation || '').trim()
    if(code && LANGUAGE_BY_CATEGORY[info.category] === 'ja'){
      set = await tcgdexJson(`/ja/sets/${encodeURIComponent(code)}`)
    } else if(code){
      const sets = await tcgdexJson(`/en/sets?abbreviation.official=eq:${encodeURIComponent(code)}`) || []
      const match = sets.find(e => e.cardCount?.official === total) || sets[0]
      if(match) set = await tcgdexJson(`/en/sets/${encodeURIComponent(match.id)}`)
    }
  } catch (e) {
    set = null
  }

  tcgdexSets.set(key, set)
  return set
}

const buildTrends = async ({ history, today, productGroup, length }) => {
  const week = changesOver(history, today, length, 7)
  const month = length - 1 >= 14 ? changesOver(history, today, length, 30) : []

  // Más caras hoy (no necesitan histórico)
  const priciest = []
  for (const [pid, finishes] of today) {
    const [finish, data] = Object.entries(finishes).sort((a, b) => (b[1].market || 0) - (a[1].market || 0))[0] || []
    if(data?.market >= TRENDS_MIN_PRICE) priciest.push({ pid, finish, price: data.market })
  }

  const byLanguage = (items, language) => items.filter(e => LANGUAGE_BY_CATEGORY[productGroup.get(e.pid)?.category] === language)
  const lists = {}
  for (const language of ['en', 'ja']) {
    lists[`rising7_${language}`] = byLanguage(week, language).filter(e => e.change > 0).sort((a, b) => b.change - a.change).slice(0, TRENDS_CANDIDATES)
    lists[`falling7_${language}`] = byLanguage(week, language).filter(e => e.change < 0).sort((a, b) => a.change - b.change).slice(0, TRENDS_CANDIDATES)
    lists[`rising30_${language}`] = byLanguage(month, language).filter(e => e.change > 0).sort((a, b) => b.change - a.change).slice(0, TRENDS_CANDIDATES)
    lists[`falling30_${language}`] = byLanguage(month, language).filter(e => e.change < 0).sort((a, b) => a.change - b.change).slice(0, TRENDS_CANDIDATES)
    lists[`top_${language}`] = byLanguage(priciest, language).sort((a, b) => b.price - a.price).slice(0, TRENDS_CANDIDATES)
  }

  // Datos de los productos candidatos (nombre, número, rareza): solo de sus expansiones
  const groups = new Set(Object.values(lists).flat().map(e => { const g = productGroup.get(e.pid); return `${g.category}/${g.groupId}` }))
  const products = new Map()
  for (const group of groups) {
    try {
      for (const product of await requestJson(`/tcgplayer/${group}/products`)) products.set(product.productId, product)
    } catch (e) {
      console.log(`::warning::products ${group}: ${e.message}`)
    }
  }

  const describe = async (entry) => {
    const product = products.get(entry.pid)
    const number = product?.extendedData?.find(e => e.name === 'Number')?.value
    // Sin número: sobres, cajas y demás productos sellados
    if(!product || !number) return null

    const info = productGroup.get(entry.pid)
    const [localId, total] = number.split('/')
    const set = await tcgdexSetFor(info, Number(total))
    const card = set?.cards?.find(e => String(e.localId).replace(/^0+/, '') === String(localId).replace(/^0+/, ''))

    // Solo cartas que están en TCGdex: así se pueden abrir en la app (con su ficha e imagen)
    if(!card) return null

    return {
      pid: entry.pid,
      finish: entry.finish,
      lang: LANGUAGE_BY_CATEGORY[info.category],
      // "Charizard ex - 125/197", "Pikachu - 227/S-P" -> el nombre, sin el número
      name: product.name.replace(/\s+-\s+[A-Za-z]*\d[\w\/-]*$/, '').trim(),
      number,
      set: info.groupName.replace(/^[A-Za-z0-9.]+:\s*/, ''),
      code: info.abbreviation || null,
      rarity: product.extendedData.find(e => e.name === 'Rarity')?.value || null,
      price: entry.price,
      from: entry.from ?? null,
      change: entry.change !== undefined ? Math.round(entry.change * 10) / 10 : null,
      tcgdexId: card.id,
      image: card.image || null,
    }
  }

  const result = {}
  for (const [name, candidates] of Object.entries(lists)) {
    const items = []
    for (const entry of candidates) {
      if(items.length >= TRENDS_PER_LIST) break
      const item = await describe(entry)
      if(item) items.push(item)
    }
    result[name] = items
  }

  return { lists: result }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
