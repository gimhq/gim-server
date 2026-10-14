import { loadConfig } from './config'
import { startServer } from './server'

startServer(loadConfig())
