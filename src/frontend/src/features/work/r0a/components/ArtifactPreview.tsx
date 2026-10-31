import ReactMarkdown from 'react-markdown'

import { css } from '@/styled-system/css'

const markdownBody = css({
  marginTop: 'sm',
  padding: 'md',
  borderRadius: 'control',
  backgroundColor: 'surface.canvas',
  textStyle: 'bodyMedium',
  lineHeight: 1.7,
  overflowWrap: 'anywhere',
  '& h1, & h2, & h3, & h4': {
    marginTop: 'md',
    marginBottom: 'xs',
    fontWeight: 'bold',
    lineHeight: 1.35,
  },
  '& h1': { textStyle: 'titleLarge' },
  '& h2': { textStyle: 'titleMedium' },
  '& p, & ul, & ol': { marginY: 'xs' },
  '& ul, & ol': { paddingLeft: 'lg' },
  '& li': { marginY: 'xxs' },
  '& code': {
    fontFamily: 'mono',
    backgroundColor: 'surface.default',
    paddingX: 'xxs',
    borderRadius: 'control',
  },
  '& pre': {
    backgroundColor: 'surface.default',
    padding: 'sm',
    borderRadius: 'control',
    overflowX: 'auto',
  },
  '& pre code': { backgroundColor: 'transparent', padding: 0 },
  '& blockquote': {
    borderLeft: '3px solid token(colors.border.subtle)',
    paddingLeft: 'sm',
    color: 'text.secondary',
    marginY: 'sm',
  },
  '& a': { color: 'text.link' },
})

const plainBody = css({
  marginTop: 'sm',
  padding: 'md',
  borderRadius: 'control',
  backgroundColor: 'surface.canvas',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontFamily: 'mono',
  textStyle: 'bodyMedium',
})

type Props = {
  text: string
  mediaType: string
}

export const ArtifactPreview = ({ text, mediaType }: Props) =>
  mediaType === 'text/plain' ? (
    <pre className={plainBody}>{text}</pre>
  ) : (
    <div className={markdownBody}>
      <ReactMarkdown
        components={{ img: ({ alt }) => <span>{alt ?? ''}</span> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
