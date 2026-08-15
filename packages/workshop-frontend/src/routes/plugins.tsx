import { createFileRoute } from '@tanstack/react-router'
import { PluginsPage } from '../PluginCenterPage'

export const Route = createFileRoute('/plugins')({component: PluginsPage})
