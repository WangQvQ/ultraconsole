import type { ButtonHTMLAttributes } from 'react'
import styles from './NeoButton.module.css'

export function NeoButton(props: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'danger' }) {
  const { tone = 'default', className, ...rest } = props
  return <button {...rest} className={[styles.btn, styles[tone], className].filter(Boolean).join(' ')} />
}

