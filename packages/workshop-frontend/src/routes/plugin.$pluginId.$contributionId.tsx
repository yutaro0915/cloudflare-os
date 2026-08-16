import { createFileRoute } from '@tanstack/react-router'
import { PluginSurfacePage } from '../PluginSurfacePage'

export const Route = createFileRoute('/plugin/$pluginId/$contributionId')({
  component: PluginSurfaceRoute,
})

function PluginSurfaceRoute() {
  const {pluginId, contributionId} = Route.useParams()
  return <PluginSurfacePage pluginId={pluginId} contributionId={contributionId} />
}
