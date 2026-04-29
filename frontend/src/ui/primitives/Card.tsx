import type { PropsWithChildren, ReactNode } from 'react'
import styles from './Card.module.css'

export function Card(props: PropsWithChildren<{ title?: string; right?: ReactNode }>) {
  return (
    <section className={styles.card}>
      {(props.title || props.right) && (
        <header className={styles.header}>
          <div className={styles.title}>{props.title}</div>
          <div className={styles.right}>{props.right}</div>
        </header>
      )}
      <div className={styles.body}>{props.children}</div>
    </section>
  )
}

