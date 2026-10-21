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
          const market = price.marketPrice ?? price.midPrice ?? null
          if(!(market > 0) && !(price.lowPrice > 0)) continue

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

main().catch(e => {
  console.error(e)
  process.exit(1)
})
