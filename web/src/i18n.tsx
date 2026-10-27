import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { LANGUAGES, parseLang, readLang, withLang, type Lang } from "../../shared/lang"
import { copy, type Copy } from "./copy"

type I18nValue = {
  lang: Lang
  text: Copy
  choose: (lang: Lang) => void
}

const fallback: I18nValue = {
  lang: "en",
  text: copy("en"),
  choose: () => {},
}

const Ctx = createContext<I18nValue>(fallback)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => (typeof window === "undefined" ? "en" : readLang(window.location.search)))
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  const choose = (next: Lang) => {
    window.history.replaceState(window.history.state, "", withLang(window.location.href, next))
    setLang(next)
  }
  return <Ctx.Provider value={{ lang, text: copy(lang), choose }}>{children}</Ctx.Provider>
}

export function useI18n(): I18nValue {
  return useContext(Ctx)
}

export function LanguageSelect() {
  const { lang, text, choose } = useI18n()
  return (
    <label className="lang-picker">
      <span>{text.language}</span>
      <select
        value={lang}
        aria-label={text.language}
        onChange={(event) => {
          const next = parseLang(event.target.value)
          if (next) choose(next)
        }}
      >
        {LANGUAGES.map((item) => (
          <option key={item.code} value={item.code}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  )
}
