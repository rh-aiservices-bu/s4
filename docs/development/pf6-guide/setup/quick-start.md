# Quick Start Guide - Frontend Development

This guide provides step-by-step instructions to start developing the PatternFly 6 frontend.

## Introduction

This guide focuses on getting the PatternFly 6 React frontend running with Vite for development. For backend setup or deployment, see the main project documentation.

## Related Files

- [**Setup Guide**](./README.md) - Prerequisites and setup overview
- [**Development Environment**](./development-environment.md) - Environment configuration
- [**PatternFly Guidelines**](../guidelines/README.md) - Development best practices
- [**Common Issues**](../troubleshooting/common-issues.md) - Troubleshooting setup problems

## Prerequisites

- Node.js 20+ and npm 9+
- Project repository already cloned
- Working from the project root directory

## Step 1: Install Frontend Dependencies

```bash
# From project root, install all dependencies
npm install

# Or install only frontend dependencies
cd frontend && npm install
```

This installs:

- PatternFly 6 components and icons
- React 18 and React Router
- Vite build tool
- TypeScript and ESLint

## Step 2: Start the Frontend Development Server

```bash
# Start the frontend with hot module replacement
npm run dev:frontend
```

This starts the Vite dev server at `http://localhost:3000` with:

- Hot Module Replacement (HMR)
- TypeScript support
- PatternFly 6 styles
- React DevTools integration

**Note**: The backend API can run separately if needed for full functionality.

## Step 3: Verify PatternFly 6 is Working

1. **Open Browser**: Navigate to `http://localhost:3000`
2. **Check Styles**: Verify PatternFly 6 components have `pf-v6-` classes
3. **Test HMR**: Edit a component and see changes instantly
4. **Inspect Elements**: Use browser DevTools to verify design tokens
5. **Toggle Theme**: Test light/dark theme switching if implemented

## What You Get

The LiteMaaS project includes:

### Pre-configured Components

- PatternFly 6 component library
- React Router for navigation
- React Query for server state management
- i18n support (EN, ES, FR)
- Authentication context with OAuth2/JWT

### Development Tools

- Vite for fast builds and HMR
- TypeScript for type safety
- ESLint for code quality
- Prettier for code formatting

### Testing Setup

- Vitest for unit tests
- Playwright for E2E tests
- Testing utilities and fixtures

## Next Steps

1. **Explore the Codebase**: Review the generated file structure
2. **Read Documentation**: Check [PatternFly Guidelines](../guidelines/README.md)
3. **Start Development**: Begin building your application components
4. **Configure Environment**: Set up [Development Environment](./development-environment.md) tools

## Frontend Development Workflow

### Key Directories

- `frontend/src/components` - PatternFly 6 React components
- `frontend/src/pages` - Page-level components
- `frontend/src/services` - API service layer
- `frontend/src/assets` - Static assets and styles

### Development Best Practices

1. **Follow PatternFly 6 Guidelines** - See [PatternFly Guidelines](../guidelines/README.md)
2. **Use Design Tokens** - Never hardcode colors or spacing
3. **Test Both Themes** - Verify in light and dark modes
4. **Check Accessibility** - Use proper ARIA labels
5. **Use TypeScript** - Maintain type safety

## Troubleshooting Frontend Issues

### Common Problems

1. **Port 3000 in use**: Change port in `frontend/vite.config.ts`
2. **Vite HMR not working**: Clear cache with `rm -rf frontend/node_modules/.vite`
3. **PatternFly styles missing**: Ensure `@patternfly/react-core/dist/styles/base.css` is imported
4. **TypeScript errors**: Run `npm run type-check` to identify issues
5. **ESLint errors**: Run `npm run lint:fix` to auto-fix

For more issues, see [Common Issues](../troubleshooting/common-issues.md)

For detailed troubleshooting, see [Common Issues](../troubleshooting/common-issues.md).

## Success Indicators

You're ready for PatternFly 6 development when:

- ✅ Frontend server running at `http://localhost:3000`
- ✅ PatternFly 6 components render with `pf-v6-` classes
- ✅ Hot Module Replacement works instantly
- ✅ TypeScript compilation succeeds
- ✅ ESLint passes without errors

## Next Steps

1. **Learn PatternFly 6 Patterns**: Review [Component Architecture](../guidelines/component-architecture.md)
2. **Understand Design Tokens**: See [Styling Standards](../guidelines/styling-standards.md)
3. **Check Components**: Explore [Component Documentation](../components/)
4. **Migration Guide**: If upgrading from v5, see [Migration Codemods](../guidelines/migration-codemods.md)
