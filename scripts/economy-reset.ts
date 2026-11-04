import {
  defaultEconomySavePath,
  JsonEconomyStore,
} from '../src/server/economy/persistence'

const path = defaultEconomySavePath()
const store = new JsonEconomyStore(path)
await store.reset()
console.log(`Removed economy save: ${path}`)
console.log('The next server boot will create a fresh deterministic world.')
