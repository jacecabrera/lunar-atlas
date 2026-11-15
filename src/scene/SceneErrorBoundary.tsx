import { Component } from 'react'
import type { ReactNode } from 'react'
import { useApp } from '../state/appStore'

// Keeps a failing scene resource (a texture that does not load) from unmounting the whole app: the boundary renders
// its fallback (an untextured body in the same pose) and reports a readable message. Visual only; no calculation
// depends on textures.
type Props = { label: string; fallback: ReactNode; children: ReactNode }
type State = { failed: boolean }

export default class SceneErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }
  static getDerivedStateFromError(): State { return { failed: true } }
  componentDidCatch(error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    useApp.getState().reportSceneIssue(`${this.props.label} could not be loaded (${detail}); showing an untextured body`)
  }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}
